import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import logo from './assets/fairfax-logo.png';
const PortfolioDashboard = lazy(() => import('./PortfolioDashboard'));

export type Company = { cik: number; name: string; ticker: string; exchange: string | null };
type Directory = { fields: string[]; data: [number, string, string, string | null][] };

export default function SearchPage({ onSelect }: { onSelect: (company: Company) => void }) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
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
    <main className="home-page">
      <header className="home-topbar">
        <div className="home-account">
          <a className="home-brand" href="#" aria-label="Fairfax Investing Group home"><img className="home-brand-logo" src={logo} alt="Fairfax Investing Group"/></a>
          <form className="home-login-form" aria-labelledby="home-login-title" onSubmit={event => event.preventDefault()}>
            <h2 id="home-login-title">Log in</h2>
            <p>Use your email and password.</p>
            <div className="home-login-fields">
              <label className="sr-only" htmlFor="home-login-email">Email address</label>
              <input id="home-login-email" type="email" name="email" autoComplete="username" placeholder="Email" required/>
              <label className="sr-only" htmlFor="home-login-password">Password</label>
              <input id="home-login-password" type="password" name="password" autoComplete="current-password" placeholder="Password" required/>
            </div>
            <div className="home-login-actions"><button type="submit" disabled aria-describedby="home-login-availability">Log in</button><small id="home-login-availability">Sign-in coming soon</small></div>
          </form>
        </div>
        <section className="home-methodology" aria-label="Welcome and investment methodology">
          <ol>
            <li>Welcome to the Fairfax Investing Group Research Dashboard! This platform serves as a centralized hub for our investment research, where we identify, analyze, and monitor investment opportunities using a Growth at a Reasonable Price (GARP) methodology.</li>
            <li>Our Investment Philosophy: Our approach draws inspiration from the Beardstown Ladies, an investment club founded in 1983. Their 1995 bestseller, <em>The Beardstown Ladies’ Common-Sense Investment Guide</em>, popularized individual stock research and investment clubs across the country.</li>
            <li>Navigating the Dashboard: Use the toolbar on the right to access company research, evaluate financial metrics, review investment theses, and explore opportunities through our GARP framework.</li>
          </ol>
        </section>
        <section className="home-company-search" aria-labelledby="company-search-title" onFocusCapture={() => setSearchOpen(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); }}>
          <h2 id="company-search-title">Find a company</h2>
          <label className="sr-only" htmlFor="company-search">Company name or stock ticker</label>
      <div className="search-field">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input
          id="company-search"
          type="search"
          placeholder="e.g. Apple or AAPL"
          value={query}
          onChange={event => { setQuery(event.target.value); setSearchOpen(true); }}
          autoComplete="off"
          spellCheck={false}
          aria-controls="search-results"
          aria-expanded={searchOpen}
        />
        {query && <button className="clear-button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
      </div>

      <section id="search-results" hidden={!searchOpen} aria-label="Search results" aria-busy={status === 'loading'}>
        <div role="status" aria-live="polite">
          {status === 'loading' && <p className="message">Loading company directory…</p>}
          {status === 'error' && <p className="message">Couldn’t load the company directory. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
          {status === 'ready' && search && <p className="result-count">{matches.length === 0 ? `No companies found for “${query.trim()}”. Try a different name or ticker.` : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'match' : 'matches'}${matches.length > 20 ? ' · Showing the first 20' : ''}`}</p>}
        </div>

        {status === 'ready' && !search && <div className="suggestions"><span>Try</span>{['AAPL', 'MSFT', 'NVDA', 'TSLA'].map(ticker => <button key={ticker} onClick={() => setQuery(ticker)}>{ticker}</button>)}</div>}

        {status === 'ready' && search && matches.length > 0 && <ul className="results">
          {matches.slice(0, 20).map(company => <li key={`${company.cik}-${company.ticker}`}>
            <button className="company-result" onClick={() => onSelect(company)} aria-label={`Create stock study for ${company.name}, ${company.ticker}`}>
              <span className="company-info"><strong>{company.name}</strong><span>{company.ticker}<span className="separator">·</span>{company.exchange || 'Exchange unavailable'}</span></span>
              <span className="result-action">Create study <span aria-hidden="true">→</span></span>
            </button>
          </li>)}
        </ul>}
      </section>
        </section>
      </header>

      <Suspense fallback={<p className="portfolio-loading" role="status">Loading research dashboard…</p>}><PortfolioDashboard onStudy={ticker => {
        const company = companies.find(item => item.ticker === ticker);
        if (company) onSelect(company);
        else { setQuery(ticker); document.getElementById('company-search')?.focus(); }
      }}/></Suspense>
    </main>
  );
}
