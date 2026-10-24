"""Local API and production static server. Run with python -m server.app."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import gzip
import traceback
import os
import re
import threading

from server.studies import ROOT, company_for, create_study, get_study, complete_study
from server.quotes import get_quote
from server.news import get_news
from server.portfolio import get_portfolio, start_portfolio_scheduler

STUDY_SLOTS = threading.BoundedSemaphore(4)
COMPLETION_SLOTS = threading.BoundedSemaphore(2)


def accepts_gzip(header):
    for entry in header.lower().split(','):
        encoding, *parameters = entry.strip().split(';')
        if encoding == 'gzip':
            try:
                quality = next((float(value.split('=', 1)[1]) for value in parameters if value.strip().startswith('q=')), 1)
            except ValueError:
                return False
            return 0 < quality <= 1
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

    def json_response(self, status, data):
        body = json.dumps(data, allow_nan=False, indent=2).encode()
        compressed = len(body) >= 1024 and accepts_gzip(self.headers.get('Accept-Encoding', ''))
        if compressed:
            body = gzip.compress(body, compresslevel=1, mtime=0)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Vary', 'Accept-Encoding')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
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
        if path == '/api/portfolio':
            return self.json_response(200, get_portfolio())
        news_match = re.fullmatch(r'/api/news/([A-Z0-9][A-Z0-9.\-]{0,14})', path)
        if news_match:
            try:
                count = int(parse_qs(urlparse(self.path).query).get('count', ['25'])[0])
                if count not in range(25, 251, 25):
                    raise ValueError('Invalid news count.')
            except ValueError:
                return self.json_response(400, {'error': 'Invalid news count.'})
            try:
                return self.json_response(200, get_news(news_match.group(1), count))
            except Exception:
                return self.json_response(503, {'error': 'Recent news is temporarily unavailable. Please try again.'})
        quote_match = re.fullmatch(r'/api/quotes/([A-Z0-9][A-Z0-9.\-]{0,14})', path)
        if quote_match:
            try:
                return self.json_response(200, get_quote(quote_match.group(1)))
            except Exception:
                return self.json_response(503, {'error': 'The latest market quote is temporarily unavailable.'})
        match = re.fullmatch(r'/api/studies/([a-f0-9-]{36})', path)
        if match:
            study = get_study(match.group(1))
            return self.json_response(200, study) if study else self.json_response(404, {'error': 'Study not found. Return to search to create one.'})
        if path.startswith('/api/'):
            return self.json_response(404, {'error': 'API route not found.'})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        completion = re.fullmatch(r'/api/studies/([a-f0-9-]{36})/complete', path)
        if path != '/api/studies' and not completion:
            return self.json_response(404, {'error': 'API route not found.'})
        # JSON requests only; no cross-origin API access is enabled.
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.json_response(415, {'error': 'Expected application/json.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048:
                raise ValueError('Invalid request size.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected an object.')
            stage = parse_qs(urlparse(self.path).query).get('stage', ['complete'])[0]
            if stage not in ('fundamentals', 'complete'):
                raise ValueError('Invalid study stage.')
            if not completion and (not isinstance(body.get('ticker'), str) or type(body.get('cik')) is not int):
                raise ValueError('Provide a ticker and numeric CIK from the company directory.')
            company = company_for(body['ticker'], body['cik']) if not completion else None
        except (ValueError, TypeError):
            return self.json_response(400, {'error': 'Choose a valid company from the search results.'})
        slots = COMPLETION_SLOTS if completion else STUDY_SLOTS
        if not slots.acquire(blocking=False):
            return self.json_response(429, {'error': 'Several studies are being created. Please try again shortly.'})
        try:
            if completion:
                return self.json_response(200, complete_study(completion.group(1)))
            return self.json_response(201, create_study(company, fundamentals_only=stage == 'fundamentals'))
        except LookupError:
            return self.json_response(404, {'error': 'Study not found.'})
        except Exception:
            traceback.print_exc()
            return self.json_response(500, {'error': 'Could not save this study. Please try again.'})
        finally:
            slots.release()


if __name__ == '__main__':
    port = int(os.environ.get('API_PORT', '8000'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    portfolio_scheduler = start_portfolio_scheduler()
    print(f'Stock study API: http://127.0.0.1:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        portfolio_scheduler.set()
        server.server_close()
