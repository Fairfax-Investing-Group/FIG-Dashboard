import { useEffect, useMemo, useState } from 'react';

type Company = { cik: number; name: string; ticker: string; exchange: string | null };
type Directory = { fields: string[]; data: [number, string, string, string | null][] };

export default function App() {
  const [query, setQuery] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetch(`${import.meta.env.BASE_URL}companies.json`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Unable to load directory');
        return response.json() as Promise<Directory>;
      })
      .then(directory => {
        setCompanies(directory.data.map(([cik, name, ticker, exchange]) => ({ cik, name, ticker, exchange })));
        setStatus('ready');
      })
      .catch(error => {
        if (error.name !== 'AbortError') setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  const search = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!search) return [];
    const rank = (company: Company) => {
      const ticker = company.ticker.toLowerCase();
      if (ticker === search) return 0;
      if (ticker.startsWith(search)) return 1;
      if (company.name.toLowerCase().startsWith(search)) return 2;
      return 3;
    };
    return companies
      .filter(company => `${company.ticker} ${company.name}`.toLowerCase().includes(search))
      .sort((a, b) => rank(a) - rank(b) || a.ticker.localeCompare(b.ticker));
  }, [companies, search]);

  return (
    <main className="search-page">
      <header>
        <div className="wordmark">Stock search</div>
        <h1>Find a company.</h1>
        <p>Search by company name or stock ticker.</p>
      </header>

      <label className="search-label" htmlFor="company-search">Company or ticker</label>
      <div className="search-field">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input
          id="company-search"
          type="search"
          placeholder="e.g. Apple or AAPL"
          value={query}
          onChange={event => setQuery(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-controls="search-results"
        />
        {query && <button className="clear-button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
      </div>

      <section id="search-results" aria-label="Search results" aria-busy={status === 'loading'}>
        <div role="status" aria-live="polite">
          {status === 'loading' && <p className="message">Loading company directory…</p>}
          {status === 'error' && <p className="message">Couldn’t load the company directory. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
          {status === 'ready' && search && <p className="result-count">{matches.length === 0 ? `No companies found for “${query.trim()}”. Try a different name or ticker.` : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'match' : 'matches'}${matches.length > 20 ? ' · Showing the first 20' : ''}`}</p>}
        </div>

        {status === 'ready' && !search && <div className="suggestions"><span>Try</span>{['AAPL', 'MSFT', 'NVDA', 'TSLA'].map(ticker => <button key={ticker} onClick={() => setQuery(ticker)}>{ticker}</button>)}</div>}

        {status === 'ready' && search && matches.length > 0 && <ul className="results">
          {matches.slice(0, 20).map(company => <li key={`${company.cik}-${company.ticker}`}>
            <a href={`https://www.sec.gov/edgar/browse/?CIK=${company.cik}&owner=exclude`} target="_blank" rel="noreferrer" aria-label={`${company.name}, ${company.ticker}, ${company.exchange || 'Exchange unavailable'}. View SEC filings in a new tab.`}>
              <span className="company-info"><strong>{company.name}</strong><span>{company.ticker}<span className="separator">·</span>{company.exchange || 'Exchange unavailable'}</span></span>
              <span className="result-action">View filings <span aria-hidden="true">↗</span></span>
            </a>
          </li>)}
        </ul>}
      </section>

      <footer>
        <a href="https://www.sec.gov/files/company_tickers_exchange.json" target="_blank" rel="noreferrer">SEC company directory ↗</a>
        <span>Local snapshot · US market coverage · No live prices</span>
      </footer>
    </main>
  );
}
