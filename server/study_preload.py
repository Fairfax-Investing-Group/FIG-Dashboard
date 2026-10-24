"""Short-lived, unsaved Fundamentals work started by search-result intent."""
from copy import deepcopy
from datetime import datetime, timezone
import threading
import time
import uuid

TTL_SECONDS = 60
MAX_ENTRIES = 8
_LOCK = threading.Lock()
_SLOTS = threading.BoundedSemaphore(5)
_JOBS = {}


class Preload:
    def __init__(self, company):
        self.company = company
        self.started = time.monotonic()
        self.changed = threading.Condition()
        self.latest = None
        self.version = 0
        self.done = False
        self.result = None
        self.error = None

    def publish(self, document):
        with self.changed:
            self.latest = document
            self.version += 1
            self.changed.notify_all()

    def run(self):
        from server.studies import progressive_inputs
        try:
            result = progressive_inputs(self.company, str(uuid.uuid4()), datetime.now(timezone.utc).isoformat(), self.publish)
            with self.changed:
                self.result = result
        except Exception as error:
            with self.changed:
                self.error = error
        finally:
            with self.changed:
                self.done = True
                self.changed.notify_all()
            _SLOTS.release()

    def consume(self, study_id, created_at, on_progress):
        version = 0
        while True:
            with self.changed:
                self.changed.wait_for(lambda: self.version != version or self.done)
                document = self.latest if self.version != version else None
                version = self.version
                done, error, result = self.done, self.error, self.result
            if document is not None:
                document = deepcopy(document)
                document['Study'].update(StudyID=study_id, DateCreated=created_at, DateModified=created_at)
                on_progress(document)
            if done:
                if error:
                    raise error
                return result


def start_preload(company):
    key = (company['cik'], company['ticker'])
    with _LOCK:
        now = time.monotonic()
        for old_key, job in list(_JOBS.items()):
            if now - job.started >= TTL_SECONDS:
                del _JOBS[old_key]
        if key in _JOBS:
            return True
        if not _SLOTS.acquire(blocking=False):
            return False
        if len(_JOBS) >= MAX_ENTRIES:
            del _JOBS[min(_JOBS, key=lambda entry: _JOBS[entry].started)]
        job = _JOBS[key] = Preload(company)
        threading.Thread(target=job.run, name='study-preload', daemon=True).start()
        return True


def take_preload(company):
    # Only a real selection consumes the inputs and persists its own study ID.
    with _LOCK:
        job = _JOBS.pop((company['cik'], company['ticker']), None)
    if job is None or time.monotonic() - job.started >= TTL_SECONDS:
        return None
    with job.changed:
        if job.done and (job.error or job.result[1]):
            # Speculative failures must not prevent a normal fresh creation.
            return None
    return job
