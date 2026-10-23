import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import SearchPage, { type Company } from './SearchPage';
const StudyPage = lazy(() => import('./StudyPage'));
import type { Study, StudyDocument } from './types';
import { studyView } from './studyDocument';

const readRoute = () => window.location.hash.replace(/^#/, '');

async function readResponse(response: Response): Promise<Study> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The study backend is unavailable. Start the app with npm run dev and try again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the study. Please try again.');
  return studyView(data as StudyDocument);
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [study, setStudy] = useState<Study | null>(null);
  const [pending, setPending] = useState<Company | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Study>());
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const navigate = () => {
      request.current?.abort();
      setPending(null);
      setLoading(false);
      setError(null);
      setRoute(readRoute());
    };
    window.addEventListener('hashchange', navigate);
    return () => { window.removeEventListener('hashchange', navigate); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!route) { setStudy(null); return; }
    const match = /^\/study\/([a-f0-9-]{36})$/.exec(route);
    if (!match) { setError('This study link is invalid. Return to search to create a study.'); return; }
    const cached = cache.current.get(match[1]);
    if (cached) { setStudy(cached); setLoading(false); return; }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    fetch(`/api/studies/${match[1]}`, { signal: controller.signal })
      .then(readResponse)
      .then(data => { cache.current.set(data.id, data); setStudy(data); })
      .catch(error => { if (error.name !== 'AbortError') setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [route]);

  async function createStudy(company: Company) {
    if (request.current && !request.current.signal.aborted && loading) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(company);
    setError(null);
    setLoading(true);
    try {
      const data = await fetch('/api/studies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: company.ticker, cik: company.cik }),
        signal: controller.signal,
      }).then(readResponse);
      if (controller.signal.aborted) return;
      cache.current.set(data.id, data);
      setStudy(data);
      setPending(null);
      window.location.hash = `/study/${data.id}`;
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not create this study.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function backToSearch() {
    request.current?.abort();
    setPending(null);
    setError(null);
    setLoading(false);
    setStudy(null);
    window.location.hash = '';
  }

  if (loading || error) return <main className="search-page state-page">
    <button className="back-button" onClick={backToSearch}>← Back to search</button>
    {loading ? <div role="status" className="loading-state"><div className="spinner"/><h1>{pending ? `Studying ${pending.ticker}` : 'Opening your study'}</h1><p>{pending ? 'Fetching annual financials from SEC and ten years of prices through yfinance.' : 'Loading your saved study.'}</p><small>This can take up to a minute. Your study will show any unavailable data.</small></div> : <div role="alert" className="error-state"><h1>Couldn’t open the study.</h1><p>{error}</p>{pending && <button className="primary-button" onClick={() => createStudy(pending)}>Try again</button>}</div>}
  </main>;
  if (route && study) return <Suspense fallback={<main className="search-page"><p role="status">Loading study charts…</p></main>}><StudyPage study={study} onBack={backToSearch} onRefresh={() => createStudy(study.company)}/></Suspense>;
  return <SearchPage onSelect={createStudy}/>;
}
