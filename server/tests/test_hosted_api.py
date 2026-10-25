"""Exercise real HTTP CORS responses without upstream provider requests."""
import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import requests
from server.app import Handler
from server.study_preload import Preload


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class HostedAPITests(unittest.TestCase):
    def test_configured_origin_preflight_json_stream_and_export(self):
        origin = 'https://research.fairfaxinvestinggroup.com'
        document = {'SchemaVersion': 1, 'Study': {'StudyID': '00000000-0000-0000-0000-000000000001'}, 'Company': {'Ticker': 'TEST'}, 'Metadata': {}}
        def create(*args, **kwargs):
            kwargs['on_progress'](document)
            return document
        with patch.dict(os.environ, {'STUDY_ALLOWED_ORIGINS': origin}), patch('server.app.create_study', side_effect=create), patch('server.app.company_for', return_value={}), patch('server.app.fundamentals_view', side_effect=lambda doc: doc), patch('server.app.get_study', return_value=document):
            server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                preflight = requests.options(base + '/api/studies', headers={'Origin': origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}, timeout=5)
                self.assertEqual(preflight.status_code, 204)
                self.assertEqual(preflight.headers['Access-Control-Allow-Origin'], origin)
                self.assertIn('POST', preflight.headers['Access-Control-Allow-Methods'])
                self.assertEqual(preflight.headers['Access-Control-Allow-Headers'], 'Content-Type, Accept')
                health = requests.get(base + '/api/health', headers={'Origin': origin}, timeout=5)
                self.assertEqual(health.json(), {'status': 'ok'})
                self.assertEqual(health.headers['Access-Control-Allow-Origin'], origin)
                stream = requests.post(base + '/api/studies?stage=fundamentals', json={'ticker': 'TEST', 'cik': 1}, headers={'Origin': origin, 'Accept': 'application/x-ndjson'}, timeout=5)
                self.assertEqual(stream.headers['Access-Control-Allow-Origin'], origin)
                self.assertEqual([json.loads(line)['type'] for line in stream.text.splitlines()], ['progress', 'ready'])
                job = Preload({'ticker': 'TEST', 'cik': 1})
                job.latest, job.version, job.done, job.result = document, 1, True, ({}, {})
                with patch('server.app.start_preload', return_value=True), patch('server.app.get_preload', return_value=job):
                    preview = requests.post(base + '/api/studies/preload', json={'ticker': 'TEST', 'cik': 1}, headers={'Origin': origin, 'Accept': 'application/x-ndjson'}, timeout=5)
                    self.assertEqual(preview.headers['Access-Control-Allow-Origin'], origin)
                    self.assertEqual([json.loads(line)['type'] for line in preview.text.splitlines()], ['progress', 'ready'])
                    self.assertIsNotNone(job.result, 'Preview must not consume selected-company inputs')
                export = requests.get(base + '/api/studies/' + document['Study']['StudyID'] + '?download=1', headers={'Origin': origin}, timeout=5)
                self.assertEqual(export.json(), document)
                self.assertEqual(export.headers['Content-Disposition'], 'attachment; filename="TEST-study.json"')
                blocked = requests.options(base + '/api/studies', headers={'Origin': 'https://other.example'}, timeout=5)
                self.assertEqual(blocked.status_code, 403)
                self.assertNotIn('Access-Control-Allow-Origin', blocked.headers)
                self.assertNotIn('Access-Control-Allow-Origin', requests.get(base + '/api/health', timeout=5).headers)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=5)
