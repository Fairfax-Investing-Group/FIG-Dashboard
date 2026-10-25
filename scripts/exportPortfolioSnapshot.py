"""Refresh the end-of-day portfolio and export a static Pages fallback."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.portfolio import CLASSIFICATION_VERSION, get_portfolio, refresh_if_due


OUTPUT = ROOT / 'public/portfolio-current.json'
REQUIRED_METRICS = ('beta', 'trailingPE', 'forwardPE', 'pegRatio', 'freeCashFlowYield', 'alpha', 'standardDeviation')


def main():
    refreshed = refresh_if_due()
    document = get_portfolio()
    if document.get('classificationVersion') != CLASSIFICATION_VERSION:
        raise RuntimeError('Portfolio snapshot is missing the current valuation and risk fields')
    if not document.get('lastSuccessfulAt'):
        raise RuntimeError('No successfully refreshed portfolio snapshot is available')
    missing = [holding.get('ticker', '?') for holding in document.get('holdings', [])
               if any(metric not in holding for metric in REQUIRED_METRICS)]
    if missing:
        raise RuntimeError(f'Portfolio risk/valuation fields are missing for: {", ".join(missing)}')
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(document, allow_nan=False, separators=(',', ':')) + '\n')
    print(f"Exported portfolio through {document['asOf']} ({'refreshed' if refreshed else 'current cache'}).")


if __name__ == '__main__':
    main()
