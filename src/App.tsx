import { AuthProvider } from './auth/AuthProvider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchPage, { type Company } from './SearchPage';
import LoginPage from './LoginPage';
import StudyPage from './StudyPage';
import { pendingStudy, unknownPendingStudy, rememberStudyCompany } from './pendingStudy';
import type { Study, StudyDocument } from './types';
import { StudyCache } from './studyCache';
import { readStudyStream } from './studyStream';
import { studyView } from './studyDocument';

const readRoute = () => window.location.hash.replace(/^#/, '');

async function readResponse(response: Response): Promise<StudyDocument> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The study backend is unavailable. Start the app with npm run dev and try again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the study. Please try again.');
  if (data.SchemaVersion !== 1) throw new Error('Unsupported study data version. Restart the backend and refresh.');
  return data as StudyDocument;
}

export default function App() {
  return <AuthProvider><AppContent/></AuthProvider>;
}

function AppContent() {
  const [route, setRoute] = useState(readRoute);
  const [studyDocument, setStudyDocument] = useState<StudyDocument | null>(null);
  const study = useMemo(() => studyDocument?.SchemaVersion === 1 ? studyView(studyDocument) : null, [studyDocument, studyView]);
  const [pending, setPending] = useState<Company | null>(null);
  const [pendingView, setPendingView] = useState<Study | null>(() => {
    const id = /^\/study\/([a-f0-9-]{36})$/.exec(readRoute())?.[1];
    return id ? unknownPendingStudy(id) : null;
  });
  const [loading, setLoading] = useState(Boolean(pendingView));
  const [loadRetry, setLoadRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [readyStudyId, setReadyStudyId] = useState<string | null>(null);
  const [detailsStatus, setDetailsStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [detailsRetry, setDetailsRetry] = useState(0);
  const fundamentalsReady = useCallback((id: string) => setReadyStudyId(id), []);
  const cache = useRef(new StudyCache());
  const request = useRef<AbortController | null>(null);
  const preloadGroup = useRef<string | null>(null);
  const [preparedPage, setPreparedPage] = useState<Study | null>(null);
  const preparePage = useCallback((company: Company | null) => {
    setPreparedPage(previous => company
      ? previous?.company.cik === company.cik && previous.company.ticker === company.ticker
        ? previous : pendingStudy(company, crypto.randomUUID())
      : null);
  }, []);

  useEffect(() => {
    const active = pendingView ?? study;
    const group = preloadGroup.current;
    if (!group || !active || readyStudyId !== active.id) return;
    preloadGroup.current = null;
    void fetch('/api/studies/preload/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preloadGroup: group, ticker: active.company.ticker, cik: active.company.cik }),
    }).catch(() => { /* Expiry still clears unused preloads if the server is unreachable. */ });
  }, [readyStudyId, pendingView?.id, study?.id]);

  useEffect(() => {
    const navigate = () => {
      request.current?.abort();
      const next = readRoute();
      const id = /^\/study\/([a-f0-9-]{36})$/.exec(next)?.[1];
      const saved = id ? cache.current.get(id) : null;
      setPending(null);
      setPendingView(id && !saved ? unknownPendingStudy(id) : null);
      setStudyDocument(saved ?? null);
      setLoading(Boolean(id && !saved));
      setError(null);
      setRoute(next);
    };
    window.addEventListener('hashchange', navigate);
    return () => { window.removeEventListener('hashchange', navigate); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!route || route === '/login') { setStudyDocument(null); return; }
    const match = /^\/study\/([a-f0-9-]{36})$/.exec(route);
    if (!match) { setError('This study link is invalid. Return to search to create a study.'); return; }
    const cached = cache.current.get(match[1]);
    if (cached?.SchemaVersion === 1) { setStudyDocument(cached); setPendingView(null); setLoading(false); return; }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    setPendingView(previous => previous?.id === match[1] ? previous : unknownPendingStudy(match[1]));
    fetch(`/api/studies/${match[1]}?view=study`, { signal: controller.signal })
      .then(readResponse)
      .then(data => { if (controller.signal.aborted) return; cache.current.set(data.Study.StudyID, data); rememberStudyCompany(data.Study.StudyID, studyView(data).company); setStudyDocument(data); setPendingView(null); })
      .catch(error => { if (!controller.signal.aborted && error.name !== 'AbortError') setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [route, loadRetry]);

  const studyId = studyDocument?.Study.StudyID;
  const dataStage = studyDocument?.Metadata.DataStage;
  useEffect(() => {
    // The mounted StudyPage signals that Fundamentals is on screen. Do not
    // start optional requests before the first financial response is displayed.
    if (!studyId || readyStudyId !== studyId || dataStage !== 'fundamentals' || loading || route !== `/study/${studyId}`) return;
    const controller = new AbortController();
    setDetailsStatus('loading');
    fetch(`/api/studies/${studyId}/complete?view=study`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: '{}', signal: controller.signal,
    }).then(response => readStudyStream(response, data => {
      if (!controller.signal.aborted && readRoute() === `/study/${studyId}`) {
        cache.current.set(studyId, data);
        setStudyDocument(data);
      }
    }, readResponse)).then(data => {
      if (controller.signal.aborted || readRoute() !== `/study/${studyId}`) return;
      cache.current.set(studyId, data);
      setStudyDocument(data);
      setDetailsStatus('idle');
    }).catch(error => {
      if (!controller.signal.aborted && error.name !== 'AbortError') setDetailsStatus('error');
    });
    return () => controller.abort();
  }, [studyId, dataStage, readyStudyId, loading, route, detailsRetry]);

  function preloadStudy(company: Company, priority = 0): Promise<boolean> {
    // Scope speculative work to this search so opening a study can discard it.
    preloadGroup.current ??= crypto.randomUUID();
    return fetch('/api/studies/preload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: company.ticker, cik: company.cik, preloadGroup: preloadGroup.current, priority }),
    }).then(response => response.ok).catch(() => false);
  }

  async function createStudy(company: Company, retryId?: string) {
    if (request.current && !request.current.signal.aborted && loading) return;
    const controller = new AbortController();
    request.current = controller;
    const prepared = preparedPage?.company.cik === company.cik && preparedPage.company.ticker === company.ticker ? preparedPage : null;
    const id = retryId ?? prepared?.id ?? crypto.randomUUID();
    const group = preloadGroup.current;
    const initial = retryId && pendingView?.id === retryId ? pendingView
      : study && study.company.cik === company.cik ? { ...study, id } : prepared ?? pendingStudy(company, id);
    rememberStudyCompany(id, company);
    setPendingView(initial);
    setPreparedPage(null);
    setStudyDocument(null);
    setPending(company);
    setReadyStudyId(null);
    setDetailsStatus('idle');
    setError(null);
    setLoading(true);
    try {
      const data = await fetch('/api/studies?stage=fundamentals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ ticker: company.ticker, cik: company.cik, studyId: id, preloadGroup: group }),
        signal: controller.signal,
      }).then(response => readStudyStream(response, document => {
        if (!controller.signal.aborted) setPendingView(studyView(document));
      }, readResponse));
      if (controller.signal.aborted) return;
      cache.current.set(data.Study.StudyID, data);
      setStudyDocument(data);
      setPending(null);
      setPendingView(null);
      setRoute(`/study/${data.Study.StudyID}`);
      window.location.hash = `/study/${data.Study.StudyID}`;
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
    setStudyDocument(null);
    setPendingView(null);
    setPreparedPage(null);
    setRoute('');
    window.location.hash = '';
  }

  if (route === '/login') return <LoginPage/>;
  const displayedStudy = pendingView ?? study;
  const showingStudy = Boolean(displayedStudy && (pendingView || route));
  const pageStudy = showingStudy ? displayedStudy : !route ? preparedPage : null;
  return <>
  <div hidden={!showingStudy} inert={!showingStudy}>
  {pageStudy && <StudyPage
    key={pageStudy.id} study={pageStudy} onBack={backToSearch}
    onRefresh={() => createStudy(pageStudy.company)} onFundamentalsReady={showingStudy ? fundamentalsReady : undefined}
    fundamentalsStatus={!showingStudy || pendingView ? error ? 'error' : 'loading' : 'idle'}
    fundamentalsError={error}
    onRetryFundamentals={() => pending ? createStudy(pending, pendingView?.id) : setLoadRetry(value => value + 1)}
    detailsStatus={!pendingView && dataStage === 'fundamentals' ? detailsStatus === 'error' ? 'error' : 'loading' : 'idle'}
    onRetryDetails={() => setDetailsRetry(value => value + 1)}/>}
  </div>
  {!showingStudy && (error ? <main className="search-page state-page"><button className="back-button" onClick={backToSearch}>← Back to search</button><div role="alert" className="error-state"><h1>Couldn’t open the study.</h1><p>{error}</p></div></main>
    : <SearchPage onSelect={createStudy} onPreload={preloadStudy} onPreparePage={preparePage}/>)}
  </>;
}
