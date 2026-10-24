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
_CLOSED_GROUPS = {}


class Preload:
    def __init__(self, company, group=None, priority=None):
        self.company = company
        self.group = group
        self.priority = priority
        self.cancelled = threading.Event()
        self.discarded = False
        self.started = time.monotonic()
        self.changed = threading.Condition()
        self.latest = None
        self.version = 0
        self.done = False
        self.result = None
        self.error = None

    def publish(self, document):
        with self.changed:
            if self.discarded:
                return
            self.latest = document
            self.version += 1
            self.changed.notify_all()

    def run(self):
        from server.studies import progressive_inputs
        try:
            result = progressive_inputs(self.company, str(uuid.uuid4()), datetime.now(timezone.utc).isoformat(), self.publish, cancelled=self.cancelled)
            with self.changed:
                if not self.discarded:
                    self.result = result
        except Exception as error:
            with self.changed:
                if not self.discarded:
                    self.error = RuntimeError(str(error))
        finally:
            with self.changed:
                self.done = True
                self.changed.notify_all()
            _SLOTS.release()

    def discard(self):
        with self.changed:
            self.discarded = True
            self.cancelled.set()
            self.latest = None
            self.result = None
            self.error = None

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
                with self.changed:
                    self.latest = None
                    self.result = None
                    self.error = None
                if error:
                    raise error
                return result


def preload_key(company, group=None):
    company_key = (company['cik'], company['ticker'])
    return (group, *company_key) if group else company_key


def _discard_locked(key):
    from server.yahoo_profile import discard_profile
    job = _JOBS.pop(key)
    job.discard()
    if not any(other.company['ticker'] == job.company['ticker'] for other in _JOBS.values()):
        discard_profile(job.company['ticker'])
    return job


def start_preload(company, group=None, priority=None):
    ensure_preload_reaper()
    key = preload_key(company, group)
    with _LOCK:
        now = time.monotonic()
        for closed, (expires, _) in list(_CLOSED_GROUPS.items()):
            if expires <= now:
                del _CLOSED_GROUPS[closed]
        closed = _CLOSED_GROUPS.get(group)
        if closed and closed[1] != (company['cik'], company['ticker']):
            return False
        for old_key, job in list(_JOBS.items()):
            if now - job.started >= TTL_SECONDS:
                _discard_locked(old_key)
        if key in _JOBS:
            return True
        if not _SLOTS.acquire(blocking=False):
            return False
        if len(_JOBS) >= MAX_ENTRIES:
            _discard_locked(min(_JOBS, key=lambda entry: _JOBS[entry].started))
        job = _JOBS[key] = Preload(company, group, priority)
        threading.Thread(target=job.run, name='study-preload', daemon=True).start()
        return True


def take_preload(company, group=None):
    # Only a real selection consumes the inputs and persists its own study ID.
    with _LOCK:
        job = _JOBS.pop(preload_key(company, group), None)
    if job is None:
        return None
    if time.monotonic() - job.started >= TTL_SECONDS:
        job.discard()
        return None
    with job.changed:
        if job.done and (job.error or job.result[1]):
            # Speculative failures must not prevent a normal fresh creation.
            return None
    return job


def clear_unselected_preloads(group, selected):
    from server.yahoo_profile import discard_profile
    keep = (selected['cik'], selected['ticker'])
    with _LOCK:
        now = time.monotonic()
        for closed, (expires, _) in list(_CLOSED_GROUPS.items()):
            if expires <= now:
                del _CLOSED_GROUPS[closed]
        _CLOSED_GROUPS[group] = (now + TTL_SECONDS, keep)
        discarded = []
        for key, job in list(_JOBS.items()):
            if job.group == group and (job.company['cik'], job.company['ticker']) != keep:
                del _JOBS[key]
                job.discard()
                discarded.append(job.company['ticker'])
        for ticker in set(discarded):
            if not any(job.company['ticker'] == ticker for job in _JOBS.values()):
                discard_profile(ticker)
    return len(discarded)


_REAPER_STARTED = False


def expire_preloads(now=None):
    from server.yahoo_profile import expire_profiles, discard_profile
    now = time.monotonic() if now is None else now
    with _LOCK:
        symbols = []
        for key, job in list(_JOBS.items()):
            if now - job.started >= TTL_SECONDS:
                del _JOBS[key]
                job.discard()
                symbols.append(job.company['ticker'])
        for group, (expires, _) in list(_CLOSED_GROUPS.items()):
            if expires <= now:
                del _CLOSED_GROUPS[group]
        for symbol in symbols:
            if not any(job.company['ticker'] == symbol for job in _JOBS.values()):
                discard_profile(symbol)
    expire_profiles()


def ensure_preload_reaper():
    global _REAPER_STARTED
    with _LOCK:
        if _REAPER_STARTED:
            return
        _REAPER_STARTED = True
    def reap():
        while True:
            threading.Event().wait(5)
            expire_preloads()
    threading.Thread(target=reap, name='preload-cleanup', daemon=True).start()
