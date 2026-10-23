"""Local API and production static server. Run with python -m server.app."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import traceback
import os
import re
import threading

from server.studies import ROOT, company_for, create_study, get_study

STUDY_SLOTS = threading.BoundedSemaphore(4)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

    def json_response(self, status, data):
        body = json.dumps(data, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/health':
            return self.json_response(200, {'status': 'ok'})
        match = re.fullmatch(r'/api/studies/([a-f0-9-]{36})', path)
        if match:
            study = get_study(match.group(1))
            return self.json_response(200, study) if study else self.json_response(404, {'error': 'Study not found. Return to search to create one.'})
        if path.startswith('/api/'):
            return self.json_response(404, {'error': 'API route not found.'})
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != '/api/studies':
            return self.json_response(404, {'error': 'API route not found.'})
        # JSON requests only; no cross-origin API access is enabled.
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.json_response(415, {'error': 'Expected application/json.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048:
                raise ValueError('Invalid request size.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not isinstance(body.get('ticker'), str) or type(body.get('cik')) is not int:
                raise ValueError('Provide a ticker and numeric CIK from the company directory.')
            company = company_for(body['ticker'], body['cik'])
        except (ValueError, TypeError):
            return self.json_response(400, {'error': 'Choose a valid company from the search results.'})
        if not STUDY_SLOTS.acquire(blocking=False):
            return self.json_response(429, {'error': 'Several studies are being created. Please try again shortly.'})
        try:
            return self.json_response(201, create_study(company))
        except Exception:
            traceback.print_exc()
            return self.json_response(500, {'error': 'Could not save this study. Please try again.'})
        finally:
            STUDY_SLOTS.release()


if __name__ == '__main__':
    port = int(os.environ.get('API_PORT', '8000'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    print(f'Stock study API: http://127.0.0.1:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
