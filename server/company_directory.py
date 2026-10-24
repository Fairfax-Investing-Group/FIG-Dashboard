"""Index the local directory once, automatically invalidating on file changes."""
from functools import lru_cache
import json
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'public' / 'companies.json'


@lru_cache(maxsize=1)
def _index(path, modified, size):
    entries = json.loads(Path(path).read_text())['data']
    companies = {(cik, ticker): {'cik': cik, 'name': name, 'ticker': ticker, 'exchange': exchange}
                 for cik, name, ticker, exchange in entries}
    return companies, {company['ticker'].replace('.', '-'): company for company in companies.values()}


def indexes():
    stat = PATH.stat()
    return _index(str(PATH), stat.st_mtime_ns, stat.st_size)


def company_for(ticker, cik):
    company = indexes()[0].get((cik, ticker))
    if company is None:
        raise ValueError('Select a company from the search results.')
    return dict(company)
