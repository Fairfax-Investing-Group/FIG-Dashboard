import { AuthProvider } from './auth/AuthProvider';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchPage, { type Company } from './SearchPage';
import LoginPage from './LoginPage';
import StudyPage from './StudyPage';
import { pendingStudy, unknownPendingStudy, rememberStudyCompany } from './pendingStudy';
import type { Study, StudyDocument } from './types';
import type { SavedStudy } from './lib/studyInputs';
import { StudyCache } from './studyCache';
import { readStudyStream } from './studyStream';
import { studyView, studyCompany } from './studyDocument';
import { apiUrl } from './lib/api';
import { loadStaticStudy } from './lib/staticStudy';
import { readStudyResponse, postStudy, isAbortError } from './lib/studyApi';

type BrowserPreload = { controller: AbortController; document?: StudyDocument; view?: Study; renderedDocument?: StudyDocument; expires: number; timer: ReturnType<typeof setTimeout> };
const disposePreload = (entry: BrowserPreload) => { entry.controller.abort(); clearTimeout(entry.timer); };
const companyKey = (company: Company) => `${company.cik}:${company.ticker}`;
const previewView = (entry: BrowserPreload, page: Study) => {
  if (entry.view?.id === page.id && entry.renderedDocument === entry.document) return entry.view;
  const document = entry.document!;
  entry.renderedDocument = document;
  entry.view = studyView({ ...document, Study: { ...document.Study, StudyID: page.id, DateCreated: page.createdAt } });
  return entry.view;
};

const readRoute = () => window.location.hash.replace(/^#/, '');

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
  const browserPreloads = useRef(new Map<string, BrowserPreload>());
  const [restoredInputs, setRestoredInputs] = useState<{ id: string; saved: SavedStudy } | null>(null);
  const [preparedPages, setPreparedPages] = useState<Study[]>([]);
  const pageMountWaiters = useRef<(() => void)[]>([]);
  const preparePages = useCallback((companies: Company[]) => new Promise<void>(resolve => {
    pageMountWaiters.current.push(resolve);
    if (!companies.length) clearBrowserPreloads();
    setPreparedPages(previous => companies.slice(0, 5).map(company => {
      const page = previous.find(page => companyKey(page.company) === companyKey(company)) ?? pendingStudy(company, crypto.randomUUID());
      const cached = browserPreloads.current.get(companyKey(company));
      return cached?.document && cached.expires > Date.now() ? previewView(cached, page) : page;
    }));
  }), []);
  function clearBrowserPreloads() {
    for (const entry of browserPreloads.current.values()) { disposePreload(entry); }
    browserPreloads.current.clear();
  }
  useEffect(() => () => clearBrowserPreloads(), []);

  useEffect(() => {
    // Child pages have mounted before this passive effect resolves the first stage.
    pageMountWaiters.current.splice(0).forEach(resolve => resolve());
  }, [preparedPages]);

  useEffect(() => {
    const active = pendingView ?? study;
    const group = preloadGroup.current;
    if (!group || !active || readyStudyId !== active.id) return;
    preloadGroup.current = null;
    void fetch(apiUrl('/api/studies/preload/clear'), {
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
      clearBrowserPreloads();
      setPreparedPages([]);
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
    fetch(apiUrl(`/api/studies/${match[1]}?view=study`), { signal: controller.signal })
      .then(readStudyResponse)
      .then(data => { if (controller.signal.aborted) return; cache.current.set(data.Study.StudyID, data); rememberStudyCompany(data.Study.StudyID, studyCompany(data)); setStudyDocument(data); setPendingView(null); })
      .catch(async error => {
        if (controller.signal.aborted || isAbortError(error)) return;
        try {
          const data = await loadStaticStudy(match[1], controller.signal);
          if (controller.signal.aborted) return;
          cache.current.set(data.Study.StudyID, data);
          rememberStudyCompany(data.Study.StudyID, studyCompany(data));
          setStudyDocument(data);
          setPendingView(null);
        } catch (staticError) {
          if (controller.signal.aborted || isAbortError(staticError)) return;
          setError(staticError instanceof Error ? staticError.message : error.message);
        }
      })
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
    postStudy(`/api/studies/${studyId}/complete?view=study`, {}, controller.signal, data => {
      if (!controller.signal.aborted && readRoute() === `/study/${studyId}`) {
        cache.current.set(studyId, data);
        setStudyDocument(data);
      }
    }).then(data => {
      if (controller.signal.aborted || readRoute() !== `/study/${studyId}`) return;
      cache.current.set(studyId, data);
      setStudyDocument(data);
      setDetailsStatus('idle');
    }).catch(error => {
      if (!controller.signal.aborted && !isAbortError(error)) setDetailsStatus('error');
    });
    return () => controller.abort();
  }, [studyId, dataStage, readyStudyId, loading, route, detailsRetry]);

  const preloadStudy = useCallback(async (company: Company, priority = 0): Promise<boolean> => {
    preloadGroup.current ??= crypto.randomUUID();
    const group = preloadGroup.current, key = companyKey(company);
    const previous = browserPreloads.current.get(key);
    if (previous) { disposePreload(previous); browserPreloads.current.delete(key); }
    // Bound payloads, readers, and timers even while the closest match changes.
    while (browserPreloads.current.size >= 5) {
      const oldest = browserPreloads.current.keys().next().value!;
      const entry = browserPreloads.current.get(oldest)!;
      disposePreload(entry); browserPreloads.current.delete(oldest);
    }
    const controller = new AbortController();
    const entry: BrowserPreload = { controller, expires: Date.now() + 55_000, timer: setTimeout(() => {
      if (browserPreloads.current.get(key) !== entry) return;
      controller.abort(); browserPreloads.current.delete(key);
      setPreparedPages(pages => pages.map(page => companyKey(page.company) === key ? pendingStudy(page.company, page.id) : page));
    }, 55_000) };
    browserPreloads.current.set(key, entry);
    const publish = (document: StudyDocument) => {
      if (controller.signal.aborted || browserPreloads.current.get(key) !== entry) return;
      entry.document = document;
      startTransition(() => setPreparedPages(pages => pages.map(page => companyKey(page.company) === key ? previewView(entry, page) : page)));
    };
    try {
      const response = await fetch(apiUrl('/api/studies/preload'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ ticker: company.ticker, cik: company.cik, preloadGroup: group, priority }), signal: controller.signal,
      });
      if (!response.ok) throw new Error('Preload busy');
      if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
        publish(await readStudyStream(response, publish, readStudyResponse));
      }
      return !controller.signal.aborted;
    } catch {
      if (browserPreloads.current.get(key) === entry) {
        clearTimeout(entry.timer); browserPreloads.current.delete(key);
      }
      return false;
    }
  }, []);

  async function createStudy(company: Company, retryId?: string, savedInputs?: SavedStudy) {
    if (request.current && !request.current.signal.aborted && loading) return;
    const controller = new AbortController();
    request.current = controller;
    const prepared = savedInputs ? undefined : preparedPages.find(page => page.company.cik === company.cik && page.company.ticker === company.ticker);
    const id = retryId ?? prepared?.id ?? crypto.randomUUID();
    const group = preloadGroup.current;
    const cachedPreview = browserPreloads.current.get(companyKey(company));
    const page = prepared ?? pendingStudy(company, id);
    const initial = retryId && pendingView?.id === retryId ? pendingView
      : cachedPreview?.document && cachedPreview.expires > Date.now() ? previewView(cachedPreview, page)
      : study && study.company.cik === company.cik ? { ...study, id } : pendingStudy(company, id);
    clearBrowserPreloads();
    rememberStudyCompany(id, company);
    if (!retryId) setRestoredInputs(savedInputs ? { id, saved: savedInputs } : null);
    setPendingView(initial);
    setPreparedPages([]);
    setStudyDocument(null);
    setPending(company);
    setReadyStudyId(null);
    setDetailsStatus('idle');
    setError(null);
    setLoading(true);
    try {
      let data: StudyDocument;
      try {
        data = await postStudy('/api/studies?stage=fundamentals',
          { ticker: company.ticker, cik: company.cik, studyId: id, preloadGroup: group }, controller.signal, document => {
          if (!controller.signal.aborted) setPendingView(studyView(document));
        });
      } catch (apiError) {
        if (controller.signal.aborted || isAbortError(apiError)) throw apiError;
        data = await loadStaticStudy(company.ticker, controller.signal);
      }
      if (controller.signal.aborted) return;
      cache.current.set(data.Study.StudyID, data);
      if (savedInputs) setRestoredInputs({ id: data.Study.StudyID, saved: savedInputs });
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
    clearBrowserPreloads();
    setPending(null);
    setError(null);
    setLoading(false);
    setStudyDocument(null);
    setPendingView(null);
    setPreparedPages([]);
    setRoute('');
    window.location.hash = '';
  }

  if (route === '/login') return <LoginPage/>;
  const displayedStudy = pendingView ?? study;
  const showingStudy = Boolean(displayedStudy && (pendingView || route));
  const pageStudies = showingStudy && displayedStudy ? [displayedStudy] : !route ? preparedPages : [];
  return <>
  {pageStudies.map(pageStudy => <div key={pageStudy.id} className={!showingStudy ? 'prepared-study-page' : undefined} aria-hidden={!showingStudy} inert={!showingStudy}>
  <StudyPage
    study={pageStudy} active={showingStudy} initialSavedStudy={restoredInputs?.id === pageStudy.id ? restoredInputs.saved : undefined} onBack={backToSearch}
    staticSnapshot={studyDocument?.Metadata.StaticSnapshot}
    onRefresh={saved => createStudy(pageStudy.company, undefined, saved)} onFundamentalsReady={showingStudy ? fundamentalsReady : undefined}
    fundamentalsStatus={!showingStudy || pendingView ? error ? 'error' : 'loading' : 'idle'}
    fundamentalsError={error}
    onRetryFundamentals={() => pending ? createStudy(pending, pendingView?.id) : setLoadRetry(value => value + 1)}
    detailsStatus={!pendingView && dataStage === 'fundamentals' ? detailsStatus === 'error' ? 'error' : 'loading' : 'idle'}
    onRetryDetails={() => setDetailsRetry(value => value + 1)}/>
  </div>)}
  {!showingStudy && (error ? <main className="search-page state-page"><button className="back-button" onClick={backToSearch}>← Back to search</button><div role="alert" className="error-state"><h1>Couldn’t open the study.</h1><p>{error}</p></div></main>
    : <SearchPage onSelect={(company, saved) => { void createStudy(company, undefined, saved); }} onPreload={preloadStudy} onPreparePages={preparePages}/>)}
  </>;
}
