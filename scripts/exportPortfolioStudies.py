"""Generate GitHub Pages study snapshots for the current portfolio."""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.company_directory import company_for
from server.studies import create_study
from server.fundamentals_view import study_view

PORTFOLIO = ROOT / 'public' / 'portfolio-current.json'
STUDY_DIR = ROOT / 'public' / 'studies'
INDEX = STUDY_DIR / 'index.json'


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump(value, target, separators=(',', ':'), ensure_ascii=False)
            target.write('\n')
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def write_snapshot_views(entries):
    for entry in entries:
        # Warm only chart/table inputs in browsers; keep full files for export.
        document = json.loads((ROOT / 'public' / entry['file']).read_text(encoding='utf-8'))
        preview = study_view(document)
        preview['Metadata']['StaticSnapshot'] = True
        entry['viewFile'] = entry['file'].removesuffix('.json') + '.view.json'
        atomic_json(ROOT / 'public' / entry['viewFile'], preview)


def main() -> None:
    portfolio = json.loads(PORTFOLIO.read_text(encoding='utf-8'))
    holdings = portfolio.get('holdings', [])
    if not holdings:
        raise RuntimeError('Portfolio snapshot has no holdings; refusing to replace study index.')

    existing = {}
    if INDEX.exists():
        try:
            existing = {item['ticker']: item for item in json.loads(INDEX.read_text(encoding='utf-8')).get('studies', [])}
        except (OSError, ValueError, KeyError, TypeError):
            existing = {}

    entries = []
    failures = []
    for holding in holdings:
        ticker = holding['ticker'].upper()
        study_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'fig-dashboard:portfolio-study:{ticker}'))
        filename = f'{ticker.replace(".", "-")}.json'
        target = STUDY_DIR / filename
        try:
            match = next((row for row in json.loads((ROOT / 'public' / 'companies.json').read_text(encoding='utf-8'))['data']
                          if row[2].upper() == ticker), None)
            if match is None:
                raise ValueError(f'{ticker} is not in the SEC company directory')
            company = company_for(match[2], match[0])
            document = create_study(company, include_peers=False, persist=False, fundamentals_only=False, study_id=study_id)
            annual_count = len(document.get('AnnualData', []))
            price_count = len(document.get('DailyPrices', [])) + len(document.get('WeeklyPrices', []))
            if annual_count == 0 and price_count < 20:
                raise RuntimeError('upstream sources returned no usable financial or price history')
            document.setdefault('Metadata', {})['DataStage'] = 'complete'
            document['Metadata']['StaticSnapshot'] = True
            atomic_json(target, document)
            entries.append({'ticker': ticker, 'id': study_id, 'file': f'studies/{filename}'})
            print(f'{ticker}: saved {annual_count} annual rows and {price_count} price points')
        except Exception as error:
            failures.append((ticker, str(error)))
            old = existing.get(ticker)
            if old and (ROOT / 'public' / old.get('file', '')).is_file():
                entries.append(old)
                print(f'{ticker}: refresh failed; keeping previous snapshot: {error}')
            else:
                print(f'{ticker}: snapshot unavailable: {error}')
        time.sleep(1)

    if not entries:
        raise RuntimeError('No portfolio study snapshots are available; refusing to publish an empty index.')
    write_snapshot_views(entries)
    atomic_json(INDEX, {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'portfolioAsOf': portfolio.get('asOf'),
        'studies': entries,
    })
    if failures:
        print(f'Completed with {len(failures)} refresh failure(s); retained prior snapshots where available.')


if __name__ == '__main__':
    main()
