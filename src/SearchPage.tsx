import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import LoginForm from './auth/LoginForm';
import logo from './assets/fairfax-logo.png';
const PortfolioDashboard = lazy(() => import('./PortfolioDashboard'));

export type Company = { cik: number; name: string; ticker: string; exchange: string | null };
type Directory = { fields: string[]; data: [number, string, string, string | null][] };

export default function SearchPage({ onSelect, onPreload, onPreparePage }: { onSelect: (company: Company) => void; onPreload?: (company: Company, priority?: number) => void | boolean | Promise<void | boolean>; onPreparePage?: (company: Company | null) => void }) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeMatch, setActiveMatch] = useState(-1);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const preloadTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const preloaded = useRef(new Map<string, number>());
  const preloading = useRef(new Map<string, Promise<boolean>>());
  const cancelPreload = () => {
    preloadTimers.current.forEach(clearTimeout);
    preloadTimers.current = [];
  };

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
      .sort((a, b) => rank(a) - rank(b) || a.ticker.localeCompare(b.ticker)).slice(0, 10);
  }, [companies, search]);

  const closest = matches[0];
  useEffect(() => {
    if (!searchOpen || !search || !closest) { onPreparePage?.(null); return; }
    const timer = setTimeout(() => onPreparePage?.(closest), 25);
    return () => clearTimeout(timer);
  }, [query, closest, searchOpen, onPreparePage]);

  useEffect(() => {
    if (!searchOpen || !search || !onPreload || !matches.length) return;
    let cancelled = false;
    const preload = (company: Company, priority: number, attempt = 0) => {
      const key = `${company.cik}:${company.ticker}`;
      if (Date.now() - (preloaded.current.get(key) ?? 0) < 60_000) return;
      let request = preloading.current.get(key);
      if (!request) {
        request = Promise.resolve().then(() => onPreload(company, priority)).then(result => result !== false, () => false);
        preloading.current.set(key, request);
        request.then(accepted => {
          preloading.current.delete(key);
          if (accepted) {
            preloaded.current.delete(key);
            preloaded.current.set(key, Date.now());
            while (preloaded.current.size > 8) preloaded.current.delete(preloaded.current.keys().next().value!);
          }
        });
      }
      request.then(accepted => {
        if (!accepted && !cancelled && attempt < (priority === 0 ? 10 : 3)) {
          preloadTimers.current.push(setTimeout(() => preload(company, priority, attempt + 1), 200));
        }
      });
    };
    preload(matches[0], 0);
    preloadTimers.current = [setTimeout(() => matches.slice(1, 5).forEach((company, index) => preload(company, index + 1)), 500)];
    return () => { cancelled = true; cancelPreload(); };
  }, [query, matches, searchOpen, onPreload]);

  return (
    <main className="home-page">
      <header className="home-topbar">
        <div className="home-account">
          <a className="home-brand" href="#" aria-label="Fairfax Investing Group home"><img className="home-brand-logo" src={logo} alt="Fairfax Investing Group"/></a>
          <LoginForm compact/>
        </div>
        <section className="home-methodology" aria-label="Welcome and investment methodology">
          <ol>
            <li>Welcome to the Fairfax Investing Group Research Dashboard! This platform serves as a centralized hub for our investment research, where we identify, analyze, and monitor investment opportunities using a Growth at a Reasonable Price (GARP) methodology.</li>
            <li>Our Investment Philosophy: Our approach draws inspiration from the Beardstown Ladies, an investment club founded in 1983. Their 1995 bestseller, <em>The Beardstown Ladies’ Common-Sense Investment Guide</em>, popularized individual stock research and investment clubs across the country. Building upon these principles, Fairfax Investing Group employs a GARP strategy, seeking companies that demonstrate strong financial fundamentals.</li>
            <li className="home-toolbar-instruction"><span>Using the toolbar: Use the toolbar on the right to access company research, latest news, valuation, investment theses, and financial data, including the latest SEC filings (10-Ks and 10-Qs), earnings per share (EPS), revenue, and growth metrics.</span></li>
          </ol>
        </section>
        <section className="home-company-search" aria-labelledby="company-search-title" onFocusCapture={() => setSearchOpen(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); }}>
          <h2 id="company-search-title">Find a Company</h2>
          <label className="sr-only" htmlFor="company-search">Company name or stock ticker</label>
      <div className="home-search-control"><div className="search-field">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input
          id="company-search"
          type="search"
          placeholder="e.g. Apple or AAPL"
          value={query}
          onChange={event => { setQuery(event.target.value); setSearchOpen(true); setActiveMatch(-1); }}
          role="combobox"
          aria-autocomplete="list"
          aria-describedby="company-search-help"
          aria-activedescendant={searchOpen && activeMatch >= 0 ? `company-option-${activeMatch}` : undefined}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setSearchOpen(true);
              setActiveMatch(current => matches.length ? (current + (event.key === 'ArrowDown' ? 1 : matches.length - 1) + matches.length) % matches.length : -1);
            } else if (event.key === 'Enter' && searchOpen && matches.length) {
              event.preventDefault(); cancelPreload(); onSelect(matches[activeMatch >= 0 ? activeMatch : 0]); setSearchOpen(false);
            }
          }}
          autoComplete="off"
          spellCheck={false}
          aria-controls="search-results"
          aria-expanded={searchOpen && !!search}
        />
        {query && <button className="clear-button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
      </div>

      <section id="search-results" hidden={!searchOpen || !search} aria-label="Search results" aria-busy={status === 'loading'}>
        <div role="status" aria-live="polite">
          {status === 'loading' && <p className="message">Loading company directory…</p>}
          {status === 'error' && <p className="message">Couldn’t load the company directory. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
          {status === 'ready' && search && <p className="result-count">{matches.length === 0 ? `No companies found for “${query.trim()}”. Try a different name or ticker.` : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'match' : 'matches'} · Closest matches`}</p>}
        </div>

        {status === 'ready' && !search && <div className="suggestions"><span>Try</span>{['AAPL', 'MSFT', 'NVDA', 'TSLA'].map(ticker => <button key={ticker} onClick={() => setQuery(ticker)}>{ticker}</button>)}</div>}

        {status === 'ready' && search && matches.length > 0 && <ul className="results" role="listbox" aria-label="Closest matching companies">
          {matches.map((company, index) => <li key={`${company.cik}-${company.ticker}`}>
            <button id={`company-option-${index}`} role="option" aria-selected={activeMatch === index} className="company-result" type="button" onMouseDown={event => {
              // Keep the combobox focused until click. Safari does not focus clicked
              // buttons, so input blur would otherwise hide the result before click.
              if (event.button === 0) event.preventDefault();
            }} onMouseEnter={() => setActiveMatch(index)} onFocus={() => setActiveMatch(index)} onClick={() => { cancelPreload(); onSelect(company); setSearchOpen(false); }} aria-label={`Create stock study for ${company.name}, ${company.ticker}`}>
              <span className="company-info"><strong>{company.name}</strong><span>{company.ticker}<span className="separator">·</span>{company.exchange || 'Exchange unavailable'}</span></span>
              <span className="result-action">Create study <span aria-hidden="true">→</span></span>
            </button>
          </li>)}
        </ul>}
      </section></div>
          <p id="company-search-help" className="home-search-help">Search by company name or ticker, then select a match to open its stock research and financial analysis.</p>
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
