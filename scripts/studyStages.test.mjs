import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
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
    if (url === '/api/studies?stage=fundamentals') {
      creates++;
      return creates === 1 ? core.promise : Promise.resolve(response(doc(secondId, 'fundamentals')));
    }
    if (url.endsWith('/complete')) {
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
          ? `import React, {useEffect,useState} from 'react'; export default function Page(props) {
              const [edit,setEdit] = useState('');
              useEffect(() => props.onFundamentalsReady(props.study.id), [props.study.id,props.onFundamentalsReady]);
              return <main data-study={props.study.id}><h1>{props.study.company.name}</h1><input aria-label="Forecast" value={edit} onChange={e=>setEdit(e.target.value)}/><span data-status>{props.detailsStatus}</span><button onClick={props.onBack}>Back</button><button onClick={props.onRetryDetails}>Retry details</button></main>;
            }`
          : args.path === './SearchPage'
            ? `import React from 'react'; export default function Search({onSelect}) { return <button onClick={()=>onSelect({ticker:'TEST',cik:123,name:'Test company'})}>Create study</button>; }`
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
    await click('Create study');
    assert.equal(calls.length, 1);
    assert.equal(completions.length, 0);
    assert.match(document.body.textContent, /Loading financials/);
    await React.act(async () => { core.resolve(response(doc(firstId, 'fundamentals'))); await settle(); });
    // Lazy page loading and hash navigation complete on separate event-loop turns.
    await React.act(async () => { await settle(); });
    assert.equal(completions.length, 1);
    assert.equal(document.querySelector('[data-status]').textContent, 'loading');
    const input = document.querySelector('input');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'my forecast');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
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
