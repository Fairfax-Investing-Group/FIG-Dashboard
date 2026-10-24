import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let firstId, secondId;
const doc = (id, stage, name = 'Core company') => ({
  SchemaVersion: 1, Study: { StudyID: id, DateCreated: '2026-10-24T00:00:00Z' },
  Company: { Ticker: 'TEST', CompanyName: name, CentralIndexKey: '123', ExchangeType: 'Nasdaq' },
  AnnualData: [], QuarterlyData: [], DailyPrices: [], ComputedValues: {},
  Metadata: { DataStage: stage, FinancialCurrency: 'USD', PriceCurrency: 'USD', Warnings: [],
    EPSAdjustment: { Status: 'unavailable', Events: [] },
    Sources: { SEC: { Status: 'ok' }, YahooFinance: { Status: 'ok' } } },
});
const response = (data, ok = true) => ({ ok, headers: { get: () => 'application/json' }, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('Fundamentals mounts before completion; background retries and merges preserve edits and ignore stale navigation', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const calls = [], completions = [];
  const core = deferred();
  let creates = 0;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    if (url === '/api/studies/preload/clear') return Promise.resolve(response({ cleared: 4 }));
    if (url === '/api/studies/preload') return Promise.resolve(response({ preloading: true }));
    if (url === '/api/studies?stage=fundamentals') {
      creates++;
      if (creates === 1) firstId = JSON.parse(options.body).studyId;
      else secondId = JSON.parse(options.body).studyId;
      return creates === 1 ? core.promise : Promise.resolve(response(doc(secondId, 'fundamentals')));
    }
    if (url.includes('/complete')) {
      assert.ok(document.querySelector('[data-study]'), 'Optional requests must wait for the study page to mount');
      const pending = deferred();
      completions.push(pending);
      return pending.promise;
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const dir = await mkdtemp(new URL('../.data/stages-test-', import.meta.url));
  let root;
  try {
    const outfile = `${dir}/App.mjs`;
    await build({ entryPoints: ['src/App.tsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', plugins: [{
      name: 'isolate-page-rendering', setup(build) {
        build.onResolve({ filter: /^react(?:\/|$)/, namespace: 'test-pages' }, args => ({ path: args.path, external: true }));
        build.onResolve({ filter: /^\.\/(StudyPage|SearchPage|LoginPage)$/ }, args => ({ path: args.path, namespace: 'test-pages' }));
        build.onLoad({ filter: /.*/, namespace: 'test-pages' }, args => ({ loader: 'jsx', contents: args.path === './StudyPage'
          ? `import React, {useEffect,useState} from 'react'; window.studyCodeLoaded = true; export default function Page(props) {
              const [edit,setEdit] = useState('');
              useEffect(() => props.onFundamentalsReady?.(props.study.id), [props.study.id,props.onFundamentalsReady]);
              return <main data-study={props.study.id}><h1>{props.study.company.name}</h1><input aria-label="Forecast" value={edit} onChange={e=>setEdit(e.target.value)}/><span data-status>{props.detailsStatus}</span><span data-primary>{props.fundamentalsStatus}</span><button onClick={props.onBack}>Back</button><button onClick={props.onRetryDetails}>Retry details</button></main>;
            }`
          : args.path === './SearchPage'
            ? `import React from 'react'; export default function Search({onSelect,onPreload,onPreparePage}) { const company={ticker:'TEST',cik:123,name:'Test company'}; return <><button onClick={()=>{onPreload(company);onPreparePage(company)}}>Highlight result</button><button onClick={()=>onSelect(company)}>Create study</button></>; }`
            : `export default function Login() { return null; }` }));
      },
    }] });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import(pathToFileURL(outfile).href);
    const settle = () => new Promise(resolve => setTimeout(resolve, 15));
    const click = text => React.act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === text).click(); await settle(); });
    const navigate = hash => React.act(async () => { window.location.hash = hash; await settle(); });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    await click('Highlight result');
    assert.equal(calls[0].url, '/api/studies/preload');
    const preloadGroup = JSON.parse(calls[0].options.body).preloadGroup;
    assert.ok(preloadGroup);
    assert.deepEqual(JSON.parse(calls[0].options.body), { ticker: 'TEST', cik: 123, preloadGroup, priority: 0 });
    const preparedPage = document.querySelector('[data-study]');
    assert.ok(preparedPage.closest('[hidden]'), 'Prepared page stays hidden while search is open');
    const preparedId = preparedPage.dataset.study;
    assert.equal(calls.filter(call => call.url === '/api/studies/preload/clear').length, 0, 'Preparation must not discard preloads or start completion');
    calls.length = 0;
    await click('Create study');
    assert.equal(calls.filter(call => call.url === '/api/studies?stage=fundamentals').length, 1);
    assert.equal(document.querySelector('[data-study]'), preparedPage, 'Selection reveals the mounted page without rebuilding it');
    assert.equal(firstId, preparedId);
    assert.equal(preparedPage.closest('[hidden]'), null);
    const cleanup = calls.filter(call => call.url === '/api/studies/preload/clear');
    assert.equal(cleanup.length, 1, 'Opening Fundamentals immediately clears the unselected preloads');
    assert.deepEqual(JSON.parse(cleanup[0].options.body), { ticker: 'TEST', cik: 123, preloadGroup });
    assert.equal(JSON.parse(calls.find(call => call.url === '/api/studies?stage=fundamentals').options.body).preloadGroup, preloadGroup);
    assert.equal(window.studyCodeLoaded, true, 'Study/chart code downloads before the financial response arrives');
    assert.equal(completions.length, 0);
    assert.equal(document.querySelector('h1').textContent, 'Test company');
    assert.equal(document.querySelector('[data-primary]').textContent, 'loading');
    const input = document.querySelector('input');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'my forecast');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let stream;
    const body = new ReadableStream({ start(controller) { stream = controller; } });
    const send = document => stream.enqueue(new TextEncoder().encode(JSON.stringify(document) + '\n'));
    await React.act(async () => {
      core.resolve({ ok: true, headers: { get: () => 'application/x-ndjson' }, body });
      send({ type: 'progress', document: doc(firstId, 'fundamentals', 'Partial company') });
      await settle();
    });
    assert.equal(document.querySelector('h1').textContent, 'Partial company');
    assert.equal(document.querySelector('[data-primary]').textContent, 'loading');
    assert.equal(document.querySelector('input'), input);
    assert.equal(input.value, 'my forecast');
    assert.equal(completions.length, 0, 'Background completion must wait for the persisted ready event');
    await React.act(async () => {
      send({ type: 'ready', document: doc(firstId, 'fundamentals') });
      stream.close();
      await settle();
    });
    // Hash navigation completes on a separate event-loop turn.
    await React.act(async () => { await settle(); });
    assert.equal(completions.length, 1);
    assert.equal(document.querySelector('[data-status]').textContent, 'loading');
    assert.equal(document.querySelector('input'), input, 'Initial data must fill the mounted page without replacing it');
    assert.equal(input.value, 'my forecast');
    assert.equal(document.querySelector('[data-primary]').textContent, 'idle');
    await React.act(async () => { completions[0].resolve(response({ error: 'Temporary error' }, false)); await settle(); });
    assert.equal(document.querySelector('[data-status]').textContent, 'error');
    assert.equal(document.querySelector('input').value, 'my forecast');
    await click('Retry details');
    assert.equal(completions.length, 2);
    await React.act(async () => { completions[1].resolve(response(doc(firstId, 'complete', 'Enriched company'))); await settle(); });
    assert.equal(document.querySelector('h1').textContent, 'Enriched company');
    assert.equal(document.querySelector('input').value, 'my forecast');
    assert.equal(document.querySelector('[data-status]').textContent, 'idle');
    await click('Back');
    await click('Create study');
    await React.act(async () => { await settle(); });
    assert.equal(completions.length, 3);
    await click('Back');
    assert.equal(calls.at(-1).options.signal.aborted, true);
    await React.act(async () => { completions[2].resolve(response(doc(secondId, 'complete', 'Stale company'))); await settle(); });
    assert.equal(document.querySelector('[data-study]'), null);
    await navigate(`/study/${secondId}`);
    await React.act(async () => { await settle(); });
    assert.equal(completions.length, 4, 'Reopening a partial study resumes completion');
    await React.act(async () => { completions[3].resolve(response(doc(secondId, 'complete'))); await settle(); });
    const count = calls.length;
    await navigate(`/study/${firstId}`);
    assert.equal(document.querySelector('h1').textContent, 'Enriched company');
    assert.equal(calls.length, count, 'Completed cached studies require no new requests');
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch;
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
