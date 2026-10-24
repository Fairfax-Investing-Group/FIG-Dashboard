import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const alice = { session: { user: { id: 'alice', email: 'alice@example.com' } }, loading: false };

test('save and reopen preserve explicit forecasts, exclusions, zero overrides, dates, and update the same record', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, studyAuth: alice });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ regular: null, postMarket: null, currency: 'USD' }) });
  const dir = await mkdtemp(new URL('../.data/save-test-', import.meta.url));
  let root, saved, refreshed;
  const writes = [];
  globalThis.studyRepository = {
    async create(input) { writes.push({ method: 'create', input }); saved = { ...input, id: 'cloud-id', user_id: 'alice', created_at: '2026-10-24T13:00:00Z', updated_at: '2026-10-24T13:00:00Z' }; return saved; },
    async update(id, input) { writes.push({ method: 'update', id, input }); saved = { ...saved, ...input, updated_at: '2026-10-24T14:00:00Z' }; return saved; },
    async list() { return saved ? [saved] : []; }, async get() { return saved; },
  };
  try {
    const outfile = `${dir}/save.mjs`;
    await build({ stdin: { contents: "export { default as StudyPage } from './src/StudyPage'; export { default as SavedStudies } from './src/SavedStudies';", resolveDir: process.cwd(), loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', plugins: [{ name: 'local-storage-test', setup(build) {
      build.onResolve({ filter: /(?:\.\/auth\/AuthProvider|\.\/lib\/studyRepository)$/ }, args => ({ path: args.path, namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path.endsWith('AuthProvider') ? 'export const useAuth = () => globalThis.studyAuth;' : 'export const createStudyRepository = () => globalThis.studyRepository;', loader: 'js' }));
    } }] });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { StudyPage, SavedStudies } = await import(pathToFileURL(outfile).href);
    const source = { status: 'ok', url: '', retrievedAt: null, error: null };
    const study = { id: 'local-id', company: { ticker: 'AAPL', cik: 320193, name: 'Apple', exchange: 'Nasdaq' }, createdAt: '2026-10-20T12:00:00Z', financialCurrency: 'USD', priceCurrency: 'USD',
      annual: [{ periodEnd: '2025-09-30', sales: 100e6, eps: 5, epsSplitFactor: 1, pretaxProfit: 10e6, salesSource: null, epsSource: null, pretaxProfitSource: null, highPrice: 100, lowPrice: 50, dividendPerShare: 1, pretaxMargin: 10, returnOnEquity: 15, debtToCapital: 20 }], prices: [], quarterly: [], sources: { sec: source, yfinance: source }, warnings: [], epsAdjustment: { status: 'normalized' } };
    root = createRoot(document.getElementById('root'));
    const render = props => React.act(async () => root.render(React.createElement(StudyPage, { study, onBack() {}, onRefresh(value) { refreshed = value; }, ...props })));
    const click = text => React.act(async () => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(button, text); button.click(); });
    const edit = (input, value) => React.act(async () => {
      Object.getOwnPropertyDescriptor(input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
    const label = text => [...document.querySelectorAll('label')].find(label => label.textContent.startsWith(text)).querySelector('input,select');
    await render();
    await edit(document.querySelector('[aria-label="Sales annual forecast percentage"]'), '12.5');
    await edit(document.querySelector('[aria-label="Earnings per share annual forecast percentage"]'), '8');
    await click('Valuation');
    await edit(label('High-price method'), 'manual');
    await edit(document.querySelector('[aria-label="Manual high-price forecast"]'), '150');
    await edit(label('Low-price method'), 'manual');
    await edit(document.querySelector('[aria-label="Manual low-price forecast"]'), '0');
    await click('Save study');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.sales_growth_percent, 12.5);
    assert.equal(writes[0].input.eps_growth_percent, 8);
    assert.equal(writes[0].input.manual_high_price, 150);
    assert.equal(writes[0].input.manual_low_price, 0);
    assert.equal(writes[0].input.annual_dividend, null, 'Do not store displayed calculated defaults');
    assert.equal(writes[0].input.study_made_at, study.createdAt);
    assert.equal(writes[0].input.annual, undefined);
    assert.match(document.querySelector('.study-save').textContent, /Made.*Saved/);
    assert.match(document.querySelector('.study-save').textContent, /By alice@example.com/);
    await click('Save changes');
    assert.equal(writes[1].method, 'update');
    assert.equal(writes[1].id, 'cloud-id');
    assert.equal(writes[1].input.study_made_at, undefined, 'Updates leave creation time untouched');
    await React.act(async () => root.render(React.createElement(SavedStudies, { onOpen(value) { assert.equal(value.id, 'cloud-id'); } })));
    const savedTable = document.querySelector('.saved-studies table');
    assert.deepEqual([...savedTable.querySelectorAll('thead th')].map(cell => cell.textContent), ['Company / Study', 'Made by', 'Study date', 'Last saved', 'Actions']);
    assert.match(savedTable.querySelector('tbody').textContent, /AAPL.*alice@example.com/);
    assert.equal(savedTable.querySelectorAll('tbody time').length, 2);
    await click('Open study');
    // Reopen on a new local provider snapshot, retaining the cloud identity.
    await render({ key: 'reopen', study: { ...study, id: 'new-local-id' }, initialSavedStudy: { ...saved, excluded_years: [2025], excluded_values: ['eps:2024'], management_excluded_years: [2024], management_excluded_values: ['returnOnEquity:2025'] } });
    assert.equal(document.querySelector('[aria-label="Sales annual forecast percentage"]').value, '12.5');
    await click('Valuation');
    assert.equal(document.querySelector('[aria-label="Manual high-price forecast"]').value, '150');
    assert.equal(document.querySelector('[aria-label="Manual low-price forecast"]').value, '0');
    await click('Save changes');
    const last = writes.at(-1);
    assert.equal(last.id, 'cloud-id');
    assert.deepEqual(last.input.excluded_years, [2025]);
    assert.deepEqual(last.input.excluded_values, ['eps:2024']);
    assert.deepEqual(last.input.management_excluded_values, ['returnOnEquity:2025']);
    assert.equal(saved.study_made_at, study.createdAt);
    await click('↻ Refresh study');
    assert.equal(refreshed.id, 'cloud-id');
    assert.equal(refreshed.manual_low_price, 0, 'Refreshing provider data retains saved inputs and identity');
    const update = globalThis.studyRepository.update;
    globalThis.studyRepository.update = async () => { throw new Error('Connection interrupted'); };
    await click('Save changes');
    assert.match(document.querySelector('[role="alert"]').textContent, /Could not save.*Connection interrupted/);
    assert.equal(document.querySelector('[aria-label="Manual high-price forecast"]').value, '150', 'Failed saves keep the draft');
    globalThis.studyRepository.update = update;
    globalThis.studyAuth = { session: null, loading: false };
    await render({ key: 'logged-out' });
    assert.ok([...document.querySelectorAll('button')].find(button => button.textContent === 'Log in to save'));
    assert.equal(writes.length, 3, 'Logged-out users cannot write studies');
    await click('Log in to save');
    assert.ok(document.querySelector('.study-save-login form'), 'Login is available without leaving the draft');
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch;
    delete globalThis.studyRepository; delete globalThis.studyAuth;
    dom.window.close(); await rm(dir, { recursive: true, force: true });
  }
});
