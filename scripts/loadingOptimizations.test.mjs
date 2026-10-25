import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const setup = () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('busy preloads retry and a changed query reuses its in-flight request without falsely caching rejection', async () => {
  const dom = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq'], ...Array.from({ length: 5 }, (_, i) => [i + 1, `Test ${i}`, `TEST${i}`, 'Nasdaq'])] }) });
  const dir = await mkdtemp(new URL('../.data/loading-test-', import.meta.url));
  let root;
  try {
    const outfile = `${dir}/search.mjs`;
    await build({ entryPoints: ['src/SearchPage.tsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'import.meta.env.BASE_URL': JSON.stringify('/') }, plugins: [{ name: 'portfolio', setup(build) {
      build.onResolve({ filter: /^\.\/PortfolioDashboard$/ }, () => ({ path: 'portfolio', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Portfolio() { return null; }', loader: 'js' }));
    } }] });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { default: SearchPage } = await import(pathToFileURL(outfile).href);
    let rejectBusy;
    const busy = new Promise(resolve => { rejectBusy = resolve; });
    const requests = [];
    const prepared = [];
    let finishMount;
    const firstMount = new Promise(resolve => { finishMount = resolve; });
    let finishData;
    const firstData = new Promise(resolve => { finishData = resolve; });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(SearchPage, { onSelect() {}, onPreparePages(companies) { prepared.push(companies.map(company => company.ticker)); return companies.length === 1 && companies[0].ticker === 'TEST0' ? firstMount : undefined; }, onPreload(company, priority) {
      requests.push({ ticker: company.ticker, priority });
      return requests.length === 1 ? busy : company.ticker === 'TEST0' ? firstData : true;
    } })));
    const type = async value => React.act(async () => {
      const input = document.getElementById('company-search');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await type('app');
    assert.equal(requests.length, 1);
    assert.deepEqual(prepared.at(-1), ['AAPL'], 'The first page prepares immediately without a typing delay');
    const firstPreparationCount = prepared.length;
    await type('aapl');
    assert.equal(requests.length, 1, 'The changed query must share a still-running request for the same company');
    assert.equal(prepared.length, firstPreparationCount, 'Typing with the same best match must not restart page preparation');
    await React.act(async () => { rejectBusy(false); await delay(230); });
    // Let the rejection callback schedule its retry before advancing another turn.
    await React.act(async () => { await delay(230); });
    assert.equal(requests.length, 2, 'A busy response must be retried instead of marked as preloaded');
    await type('apple');
    assert.equal(requests.length, 2, 'Accepted data is reused');
    await type('test');
    assert.equal(requests.at(-1).ticker, 'TEST0');
    assert.equal(requests.at(-1).priority, 0);
    await React.act(async () => { await delay(550); });
    assert.equal(requests.filter(request => request.ticker.startsWith('TEST')).length, 1, 'Secondary data must wait until the first data stream finishes');
    assert.deepEqual(prepared.at(-1), ['TEST0'], 'Secondary pages wait for the first page to mount');
    await React.act(async () => { finishMount(); });
    await React.act(async () => { await delay(250); });
    assert.deepEqual(prepared.at(-1), ['TEST0'], 'Secondary pages wait 500ms after the first mount');
    await type('tes');
    await React.act(async () => { await delay(300); });
    assert.deepEqual(prepared.at(-1), ['TEST0', 'TEST1', 'TEST2', 'TEST3', 'TEST4']);
    await React.act(async () => { finishData(true); });
    assert.equal(requests.filter(request => request.ticker.startsWith('TEST')).length, 1);
    await React.act(async () => { await delay(250); });
    await type('test');
    await React.act(async () => { await delay(300); });
    assert.deepEqual(requests.filter(request => request.ticker.startsWith('TEST')).map(request => request.ticker), ['TEST0', 'TEST1', 'TEST2', 'TEST3', 'TEST4']);
    await type('te');
    const count = requests.length;
    const pageCount = prepared.length;
    await React.act(async () => root.unmount()); root = null;
    await delay(520);
    assert.equal(requests.length, count, 'Leaving search cancels the four secondary timers');
    assert.equal(prepared.length, pageCount, 'Leaving search cancels pending page preparation');
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch;
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh news is reused on tab changes while manual refresh still fetches', async () => {
  const dom = setup();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ articles: [{ id: 'one', title: 'Article', url: 'https://example.com/one', publisher: 'Publisher', publishedAt: '2026-10-24T12:00:00Z', summary: '' }], retrievedAt: '2026-10-24T12:00:00Z', nextCount: null }) }; };
  const dir = await mkdtemp(new URL('../.data/news-loading-test-', import.meta.url));
  let root;
  try {
    const outfile = `${dir}/news.mjs`;
    await build({ entryPoints: ['src/NewsPage.tsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { default: NewsPage } = await import(pathToFileURL(outfile).href);
    root = createRoot(document.getElementById('root'));
    const render = active => React.act(async () => root.render(React.createElement(NewsPage, { ticker: 'TEST', active })));
    await render(true);
    assert.equal(requests, 1);
    await render(false); await render(true);
    assert.equal(requests, 1);
    assert.match(document.body.textContent, /Article/);
    await React.act(async () => document.querySelector('.news-refresh').click());
    assert.equal(requests, 2, 'An explicit refresh must bypass the tab cache');
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch;
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recent-study cache evicts old payloads and retains the most recently opened study', async () => {
  const dir = await mkdtemp(new URL('../.data/cache-loading-test-', import.meta.url));
  try {
    const outfile = `${dir}/cache.mjs`;
    await build({ entryPoints: ['src/studyCache.ts'], outfile, bundle: true, platform: 'node', format: 'esm' });
    const { StudyCache } = await import(pathToFileURL(outfile).href);
    const cache = new StudyCache(2);
    const first = { Study: { StudyID: 'first' } };
    cache.set('first', first); cache.set('second', { Study: { StudyID: 'second' } });
    assert.equal(cache.get('first'), first);
    cache.set('third', { Study: { StudyID: 'third' } });
    assert.equal(cache.size, 2);
    assert.equal(cache.get('second'), undefined);
    assert.equal(cache.get('first'), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
