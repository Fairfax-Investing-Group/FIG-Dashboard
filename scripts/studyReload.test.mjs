import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { testCacheStorage, cachedDocument } from './testCacheStorage.mjs';

test('reload displays a persisted study before the API responds and recreates missing Render IDs without remounting', async () => {
  const cached = cachedDocument(), id = cached.Study.StudyID;
  cached.AnnualData = [{ FiscalYear: 2025, AsOfDataDate: '2025-12-31', Sales: 123, EPS: 2, PTP: 20, EPSSplitFactor: 1, Sources: { Sales: null, EPS: null, PTP: null } }];
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/#/study/${id}` });
  const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, caches: testCacheStorage(), IS_REACT_ACT_ENVIRONMENT: true });
  const dir = await mkdtemp(new URL('../.data/reload-test-', import.meta.url));
  let root, answer, rebuild, completion;
  const event = (controller, type, document) => controller.enqueue(new TextEncoder().encode(JSON.stringify({ type, document }) + "\n"));
  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    if (url === `/api/studies/${id}?view=study`) return new Promise(resolve => { answer = resolve; });
    assert.equal(options.method, 'POST');
    if (url === '/api/studies?stage=fundamentals') {
      assert.equal(JSON.parse(options.body).studyId, id);
      assert.equal(JSON.parse(options.body).ticker, 'TEST');
      return Promise.resolve(new Response(new ReadableStream({ start(controller) { rebuild = controller; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    }
    if (url === `/api/studies/${id}/complete?view=study`) return Promise.resolve(new Response(new ReadableStream({ start(controller) { completion = controller; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const outfile = `${dir}/app.mjs`;
    await build({ stdin: { contents: "export { default as App } from './src/App'; export { StudyCache } from './src/studyCache';", resolveDir: process.cwd(), loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', plugins: [{ name: 'pages', setup(build) {
      build.onResolve({ filter: /^\.\/(StudyPage|SearchPage|LoginPage)$/ }, args => ({ path: args.path, namespace: 'pages' }));
      build.onResolve({ filter: /^react(?:\/|$)/, namespace: 'pages' }, args => ({ path: args.path, external: true }));
      build.onLoad({ filter: /.*/, namespace: 'pages' }, args => ({ loader: 'jsx', contents: args.path === './StudyPage'
        ? `import React,{useEffect,useState} from 'react'; export default function Page({study,onFundamentalsReady}) { const [edit,setEdit]=useState(''); useEffect(()=>onFundamentalsReady?.(study.id),[study.id,onFundamentalsReady]); return <main data-study={study.id}><h1>{study.company.name}</h1><span data-sales>{study.annual[0]?.sales}</span><input aria-label="Forecast" value={edit} onChange={e=>setEdit(e.target.value)}/></main> }`
        : 'export default function Page() {return null}' }));
    } }] });
    const { App, StudyCache } = await import(pathToFileURL(outfile).href);
    const seed = new StudyCache(); seed.set(id, cached); await seed.flush();
    const React = await import('react'), { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root'));
    const settle = () => new Promise(resolve => setTimeout(resolve, 15));
    await React.act(async () => { root.render(React.createElement(App)); await settle(); });
    assert.equal(document.querySelector('h1').textContent, 'Cached company');
    assert.ok(answer, 'Revalidation starts without waiting for a user action');
    const page = document.querySelector('main');
    await React.act(async () => { answer(Response.json({ error: 'Study not found' }, { status: 404 })); await settle(); });
    const partial = { ...cached, AnnualData: [], Company: { ...cached.Company, CompanyName: 'Profile only' }, Metadata: { ...cached.Metadata, DataStage: 'fundamentals' } };
    const fresh = { ...cached, Company: { ...cached.Company, CompanyName: 'Complete company' }, AnnualData: [{ ...cached.AnnualData[0], Sales: 456 }] };
    await React.act(async () => { event(rebuild, 'progress', partial); await settle(); });
    assert.equal(document.querySelector('h1').textContent, 'Cached company');
    assert.equal(document.querySelector('[data-sales]').textContent, '123000000');
    await React.act(async () => { event(rebuild, 'ready', { ...fresh, Metadata: { ...fresh.Metadata, DataStage: 'fundamentals' } }); rebuild.close(); await settle(); });
    assert.equal(document.querySelector('[data-sales]').textContent, '123000000', 'The full cached snapshot stays visible while daily data is replaced');
    assert.ok(completion);
    await React.act(async () => { event(completion, 'progress', partial); await settle(); });
    assert.equal(document.querySelector('[data-sales]').textContent, '123000000');
    await React.act(async () => { event(completion, 'ready', fresh); completion.close(); await settle(); });
    assert.equal(document.querySelector('h1').textContent, 'Complete company');
    assert.equal(document.querySelector('[data-sales]').textContent, '456000000');
    assert.equal(document.querySelector('main'), page);
    assert.equal(calls.filter(call => call.url.endsWith('/complete?view=study')).length, 1);
    await React.act(async () => { await settle(); root.unmount(); });
    root = createRoot(document.getElementById('root'));
    globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
    await React.act(async () => { root.render(React.createElement(App)); await settle(); });
    assert.equal(document.querySelector('h1').textContent, 'Complete company', 'A failed revalidation must retain cached data');
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch; globalThis.caches = originalCaches;
    dom.window.close(); await rm(dir, { recursive: true, force: true });
  }
});
