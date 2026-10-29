"""Local API and production static server. Run with python -m server.app."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import gzip
import zlib
import traceback
import os
import re
import threading

from server.studies import ROOT, company_for, create_study, get_study, complete_study
from server.study_preload import start_preload, clear_unselected_preloads, get_preload
from server.quotes import get_quote
from server.news import get_news
from server.fundamentals_view import fundamentals_view, study_view
from server.portfolio import get_portfolio, start_portfolio_scheduler

STUDY_SLOTS = threading.BoundedSemaphore(4)
COMPLETION_SLOTS = threading.BoundedSemaphore(2)


def allowed_origin(origin):
    if not origin:
        return False
    configured = os.environ.get('STUDY_ALLOWED_ORIGINS') or os.environ.get('CORS_ORIGINS') or 'https://research.fairfaxinvestinggroup.com'
    allowed = {value.strip().rstrip('/') for value in configured.split(',') if value.strip()}
    return origin in allowed


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

    def end_headers(self):
        origin = self.headers.get('Origin')
        if allowed_origin(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
        # Responses can differ by Origin, including when no CORS header is sent.
        self.send_header('Vary', 'Origin')
        super().end_headers()

    def do_OPTIONS(self):
        if not urlparse(self.path).path.startswith('/api/'):
            return self.json_response(404, {'error': 'API route not found.'})
        if not allowed_origin(self.headers.get('Origin')):
            return self.json_response(403, {'error': 'Frontend origin is not allowed.'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def json_response(self, status, data, download_name=None):
        body = json.dumps(data, allow_nan=False, separators=(',', ':')).encode()
        compressed = len(body) >= 1024 and accepts_gzip(self.headers.get('Accept-Encoding', ''))
        if compressed:
            body = gzip.compress(body, compresslevel=1, mtime=0)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Vary', 'Accept-Encoding')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        if download_name:
            self.send_header('Content-Disposition', f'attachment; filename="{download_name}"')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def stream_study(self, company, study_id, preload_group=None, completion=False, preload_job=None):
        # Flush each small NDJSON event, including its gzip synchronization marker.
        # Whole-response buffering would hold back the early sections.
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Vary', 'Accept-Encoding')
        compressor = zlib.compressobj(level=1, wbits=31) if accepts_gzip(self.headers.get('Accept-Encoding', '')) else None
        if compressor:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        connected = True

        def event(kind, document=None, error=None):
            nonlocal connected
            if not connected:
                return False
            value = {'type': kind}
            if document is not None:
                value['document'] = study_view(document) if completion else fundamentals_view(document)
            if error is not None:
                value['error'] = error
            try:
                body = (json.dumps(value, allow_nan=False, separators=(',', ':')) + '\n').encode()
                if compressor:
                    body = compressor.compress(body) + compressor.flush(zlib.Z_SYNC_FLUSH)
                self.wfile.write(body)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                # Persist the study even if the user navigated away mid-stream.
                connected = False
            return connected
        try:
            if preload_job is not None:
                study = preload_job.preview(lambda document: event('progress', document))
            elif completion:
                study = complete_study(study_id, on_progress=lambda document: event('progress', document))
            else:
                study = create_study(company, fundamentals_only=True, study_id=study_id,
                                     on_progress=lambda document: event('progress', document), preload_group=preload_group)
            event('ready', study)
        except Exception:
            if preload_job is not None and preload_job.discarded:
                connected = False
            else:
                traceback.print_exc()
                event('error', error='Could not save this study. Please try again.')
        finally:
            if compressor and connected:
                try:
                    self.wfile.write(compressor.flush(zlib.Z_FINISH))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if path == '/api/health':
            return self.json_response(200, {'status': 'ok'})
        if path == '/api/portfolio':
            return self.json_response(200, get_portfolio())
        news_match = re.fullmatch(r'/api/news/([A-Z0-9][A-Z0-9.\-]{0,14})', path)
        if news_match:
            try:
                count = int(query.get('count', ['25'])[0])
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
            if study and query.get('view') == ['study']:
                return self.json_response(200, study_view(study))
            if study and study['Metadata'].get('DataStage') == 'fundamentals' and query.get('view') == ['fundamentals']:
                study = fundamentals_view(study)
            if study:
                download = query.get('download') == ['1']
                filename = re.sub(r'[^A-Za-z0-9_.-]', '_', study['Company']['Ticker']) + '-study.json' if download else None
                return self.json_response(200, study, download_name=filename)
            return self.json_response(404, {'error': 'Study not found. Return to search to create one.'})
        if path.startswith('/api/'):
            return self.json_response(404, {'error': 'API route not found.'})
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        completion = re.fullmatch(r'/api/studies/([a-f0-9-]{36})/complete', path)
        preload = path == '/api/studies/preload'
        clear_preloads = path == '/api/studies/preload/clear'
        if path != '/api/studies' and not completion and not preload and not clear_preloads:
            return self.json_response(404, {'error': 'API route not found.'})
        # JSON requests only; configured frontend origins can pass CORS preflight.
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.json_response(415, {'error': 'Expected application/json.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048:
                raise ValueError('Invalid request size.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected an object.')
            stage = query.get('stage', ['complete'])[0]
            if stage not in ('fundamentals', 'complete'):
                raise ValueError('Invalid study stage.')
            if not completion and (not isinstance(body.get('ticker'), str) or type(body.get('cik')) is not int):
                raise ValueError('Provide a ticker and numeric CIK from the company directory.')
            study_id = body.get('studyId')
            if study_id is not None and (not isinstance(study_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', study_id)):
                raise ValueError('Invalid study ID.')
            preload_group = body.get('preloadGroup')
            if (clear_preloads and preload_group is None) or (preload_group is not None and (not isinstance(preload_group, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', preload_group))):
                raise ValueError('Invalid preload group.')
            company = company_for(body['ticker'], body['cik']) if not completion else None
        except (ValueError, TypeError):
            return self.json_response(400, {'error': 'Choose a valid company from the search results.'})
        if clear_preloads:
            return self.json_response(200, {'cleared': clear_unselected_preloads(preload_group, company)})
        if preload:
            priority = body.get('priority')
            if priority is not None and (type(priority) is not int or not 0 <= priority <= 4):
                return self.json_response(400, {'error': 'Invalid preload priority.'})
            accepted = start_preload(company, preload_group, priority)
            if accepted and 'application/x-ndjson' in self.headers.get('Accept', ''):
                job = get_preload(company, preload_group)
                if job is not None:
                    return self.stream_study(company, None, preload_group, preload_job=job)
            return self.json_response(202 if accepted else 429, {'preloading': accepted})
        slots = COMPLETION_SLOTS if completion else STUDY_SLOTS
        if not slots.acquire(blocking=False):
            return self.json_response(429, {'error': 'Several studies are being created. Please try again shortly.'})
        try:
            if completion:
                if 'application/x-ndjson' in self.headers.get('Accept', ''):
                    return self.stream_study(None, completion.group(1), completion=True)
                study = complete_study(completion.group(1))
                return self.json_response(200, study_view(study) if query.get('view') == ['study'] else study)
            if stage == 'fundamentals' and 'application/x-ndjson' in self.headers.get('Accept', ''):
                return self.stream_study(company, study_id, preload_group)
            study = create_study(company, fundamentals_only=stage == 'fundamentals', study_id=study_id, preload_group=preload_group)
            return self.json_response(201, fundamentals_view(study) if stage == 'fundamentals' else study)
        except LookupError:
            return self.json_response(404, {'error': 'Study not found.'})
        except Exception:
            traceback.print_exc()
            return self.json_response(500, {'error': 'Could not save this study. Please try again.'})
        finally:
            slots.release()


if __name__ == '__main__':
    port = int(os.environ.get('PORT') or os.environ.get('API_PORT', '8000'))
    host = os.environ.get('API_HOST') or os.environ.get('HOST', '127.0.0.1')
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    portfolio_scheduler = start_portfolio_scheduler()
    print(f'Stock study API: http://{host}:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        portfolio_scheduler.set()
        server.server_close()
