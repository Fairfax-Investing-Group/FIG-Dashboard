"""Run from the repository root: .venv/bin/python -m scripts.benchmarkLoading AAPL MSFT

Uses a temporary local database. No existing studies or Supabase records change.
Times are backend elapsed time, not browser paint time. Peer sampling defaults
to zero for repeatable measurements; use --peers 3 to include normal peer work.
"""
import argparse
import json
import os
import tempfile
import time

from server.company_directory import indexes
from server.fundamentals_view import study_view
from server.studies import complete_study, connection, create_study


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tickers', nargs='*', default=['AAPL'])
    parser.add_argument('--peers', type=int, default=0, choices=range(6))
    args = parser.parse_args()
    os.environ['STUDY_PEER_LIMIT'] = str(args.peers)
    results = []
    with tempfile.TemporaryDirectory() as directory:
        os.environ['STUDY_DB'] = directory + '/benchmark.sqlite3'
        for ticker in args.tickers:
            company = indexes()[1].get(ticker.upper().replace('.', '-'))
            if not company:
                parser.error(f'Unknown company ticker: {ticker}')
            first = {}
            start = time.perf_counter()
            def progress(document):
                for label, ready in [('financials', bool(document['AnnualData'])), ('weekly_chart', bool(document['WeeklyPrices']))]:
                    if ready:
                        first.setdefault(label, round((time.perf_counter() - start) * 1000, 1))
            core = create_study(company, fundamentals_only=True, on_progress=progress)
            ready = round((time.perf_counter() - start) * 1000, 1)
            with connection() as db:
                checkpoint = db.execute('select length(cast(payload as blob)) from study_inputs where id = ?', (core['Study']['StudyID'],)).fetchone()[0]
            completion_start = time.perf_counter()
            daily = []
            completed = complete_study(core['Study']['StudyID'], on_progress=lambda document: daily.append(round((time.perf_counter() - completion_start) * 1000, 1)))
            results.append({'ticker': ticker.upper(), 'first_ms': first, 'fundamentals_ready_ms': ready,
                            'daily_chart_ms_after_ready': daily[0], 'completion_ms': round((time.perf_counter() - completion_start) * 1000, 1),
                            'checkpoint_bytes': checkpoint, 'app_document_bytes': len(json.dumps(study_view(completed), separators=(',', ':')).encode()),
                            'peer_count': len(completed['Peers']), 'sources': {key: value['Status'] for key, value in completed['Metadata']['Sources'].items()}})
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
