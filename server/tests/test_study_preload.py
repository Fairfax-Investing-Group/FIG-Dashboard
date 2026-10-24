from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
from unittest.mock import patch

from server import study_preload
from server.studies import create_study, get_study, connection
from server.tests import test_weekly_fundamentals as weekly_fixtures


class StudyPreloadTests(unittest.TestCase):
    def setUp(self):
        self.fixture = weekly_fixtures.WeeklyStudyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        study_preload._JOBS.clear()
        study_preload._CLOSED_GROUPS.clear()
        self.company = self.fixture.company
        self.study_id = '00000000-0000-4000-8000-000000000001'

    def inputs(self):
        return {'sec': deepcopy(self.fixture.financials), 'yfinance': deepcopy(self.fixture.weekly)}, {}

    def test_finished_preload_is_unsaved_and_consumed_once_with_the_selected_study_id(self):
        with patch('server.studies.progressive_inputs', return_value=self.inputs()) as fetch:
            self.assertTrue(study_preload.start_preload(self.company))
            job = study_preload._JOBS[(123, 'TEST')]
            with job.changed:
                self.assertTrue(job.changed.wait_for(lambda: job.done, timeout=3))
            self.assertTrue(study_preload.start_preload(self.company), 'Repeated highlights reuse the same preload')
            with connection() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM studies').fetchone()[0], 0)
            study = create_study(self.company, fundamentals_only=True, study_id=self.study_id, on_progress=lambda doc: None)
        fetch.assert_called_once()
        self.assertEqual(study['Study']['StudyID'], self.study_id)
        self.assertEqual(get_study(self.study_id), study)
        self.assertIsNone(study_preload.take_preload(self.company))

    def test_selecting_a_running_preload_receives_existing_and_future_updates_without_duplicate_fetches(self):
        published, release, attached = (threading.Event() for _ in range(3))
        updates = []
        def fetch(company, study_id, created_at, publish, **kwargs):
            publish({'Study': {'StudyID': study_id}, 'part': 1})
            published.set()
            self.assertTrue(release.wait(3))
            publish({'Study': {'StudyID': study_id}, 'part': 2})
            return self.inputs()
        def progress(doc):
            updates.append(doc)
            attached.set()
        with patch('server.studies.progressive_inputs', side_effect=fetch) as upstream, ThreadPoolExecutor(max_workers=1) as executor:
            self.assertTrue(study_preload.start_preload(self.company))
            try:
                self.assertTrue(published.wait(3))
                task = executor.submit(create_study, self.company, fundamentals_only=True, study_id=self.study_id, on_progress=progress)
                self.assertTrue(attached.wait(3))
                self.assertEqual(updates[0]['part'], 1)
                self.assertEqual(updates[0]['Study']['StudyID'], self.study_id)
            finally:
                release.set()
            study = task.result(timeout=3)
        upstream.assert_called_once()
        self.assertEqual([doc['part'] for doc in updates], [1, 2])
        self.assertEqual(study['Study']['StudyID'], self.study_id)

    def test_expired_and_failed_preloads_do_not_replace_a_fresh_creation(self):
        for failure in (False, True):
            with patch('server.studies.progressive_inputs', side_effect=RuntimeError('temporary') if failure else None, return_value=self.inputs()):
                study_preload.start_preload(self.company)
                job = study_preload._JOBS[(123, 'TEST')]
                with job.changed:
                    self.assertTrue(job.changed.wait_for(lambda: job.done, timeout=3))
            if not failure:
                job.started -= study_preload.TTL_SECONDS + 1
            with patch('server.studies.progressive_inputs', return_value=self.inputs()) as fresh:
                study = create_study(self.company, fundamentals_only=True, persist=False, on_progress=lambda doc: None)
            fresh.assert_called_once()
            self.assertEqual(study['Company']['Ticker'], 'TEST')

    def test_all_five_top_matches_can_preload_together(self):
        release = threading.Event()
        def fetch(*args):
            self.assertTrue(release.wait(3))
            return self.inputs()
        jobs = []
        with patch('server.studies.progressive_inputs', side_effect=fetch):
            try:
                for index in range(5):
                    company = {**self.company, 'cik': index + 1, 'ticker': f'TEST{index}'}
                    self.assertTrue(study_preload.start_preload(company))
                    jobs.append(study_preload._JOBS[(index + 1, f'TEST{index}')])
            finally:
                release.set()
                for job in jobs:
                    with job.changed:
                        self.assertTrue(job.changed.wait_for(lambda: job.done, timeout=3))

    def test_preload_limit_drops_extra_speculation_without_blocking_study_creation(self):
        with patch.object(study_preload._SLOTS, 'acquire', return_value=False):
            self.assertFalse(study_preload.start_preload(self.company))
        self.assertEqual(study_preload._JOBS, {})

    def test_cleanup_wipes_unselected_data_and_keeps_selected_and_other_searches(self):
        selected = study_preload.Preload(self.company, 'search-one')
        other_company = {**self.company, 'ticker': 'OTHER', 'cik': 456}
        other = study_preload.Preload(other_company, 'search-one')
        independent = study_preload.Preload(other_company, 'search-two')
        for job in (selected, other, independent):
            job.latest = {'financials': [123]}
            job.result = self.inputs()
            job.done = True
            study_preload._JOBS[study_preload.preload_key(job.company, job.group)] = job
        self.assertEqual(study_preload.clear_unselected_preloads('search-one', self.company), 1)
        self.assertIsNone(other.latest)
        self.assertIsNone(other.result)
        self.assertTrue(other.discarded)
        self.assertIs(study_preload.take_preload(self.company, 'search-one'), selected)
        self.assertIs(study_preload.take_preload(other_company, 'search-two'), independent)
        self.assertFalse(study_preload.start_preload(other_company, 'search-one'), 'Late requests cannot recreate discarded entries')

    def test_running_discarded_job_does_not_keep_late_results_or_profiles(self):
        from server.yahoo_profile import get_profile, _PROFILES
        from unittest.mock import MagicMock
        other_company = {**self.company, 'ticker': 'DISCARD', 'cik': 456}
        started, release = threading.Event(), threading.Event()
        stock = MagicMock()
        def info():
            started.set()
            self.assertTrue(release.wait(3))
            return {'longName': 'Discarded company'}
        stock.get_info.side_effect = info
        def fetch(company, study_id, created_at, publish, **kwargs):
            profile = get_profile('DISCARD', stock=stock)
            publish({'profile': profile})
            return self.inputs()
        with patch('server.studies.progressive_inputs', side_effect=fetch):
            self.assertTrue(study_preload.start_preload(other_company, 'search-one'))
            job = study_preload._JOBS[study_preload.preload_key(other_company, 'search-one')]
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(study_preload.clear_unselected_preloads('search-one', self.company), 1)
            finally:
                release.set()
            with job.changed:
                self.assertTrue(job.changed.wait_for(lambda: job.done, timeout=3))
        self.assertIsNone(job.latest)
        self.assertIsNone(job.result)
        self.assertNotIn('DISCARD', _PROFILES)
        self.assertIsNone(study_preload.take_preload(other_company, 'search-one'))
