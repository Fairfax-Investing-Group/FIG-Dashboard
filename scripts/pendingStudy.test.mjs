import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('pending Fundamentals shows the real tables, early quote, editable forecasts, and inline retry', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 560, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 560 });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ currency: 'USD', regular: { price: 123.45, change: 1, percent: 0.8, time: '2026-10-23T20:00:00Z' }, postMarket: null }) };
  };
  const dir = await mkdtemp(new URL('../.data/pending-test-', import.meta.url));
  let root;
  try {
    const outfile = `${dir}/Pending.mjs`;
    await build({ stdin: { contents: "export {default as StudyPage} from './src/StudyPage'; export {pendingStudy, rememberStudyCompany, unknownPendingStudy} from './src/pendingStudy';", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { StudyPage, pendingStudy, rememberStudyCompany, unknownPendingStudy } = await import(pathToFileURL(outfile).href);
    const study = pendingStudy({ ticker: 'TEST', cik: 123, name: 'Test Company', exchange: 'Nasdaq' }, 'pending-test');
    rememberStudyCompany(study.id, study.company);
    assert.deepEqual(unknownPendingStudy(study.id).company, study.company, 'Known company details remain available while reopening a study');
    let retries = 0;
    const props = { study, onBack() {}, onRefresh() {}, onRetryFundamentals() { retries++; }, fundamentalsStatus: 'loading' };
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(StudyPage, props)));
    assert.equal(document.querySelector('h1').textContent, 'Test Company');
    assert.match(document.querySelector('.company-classification').textContent, /Nasdaq/);
    assert.equal(document.querySelector('.regular-market-quote strong').textContent, '$123.45');
    assert.deepEqual(requests, ['/api/quotes/TEST']);
    assert.equal(document.querySelector('.study-background-status'), null);
    assert.equal(document.querySelectorAll('.chart-series-item.is-hidden').length, 0);
    assert.doesNotMatch(document.body.textContent, /Loading company|Loading financials|will appear here/);
    assert.equal(document.querySelectorAll('.pending-period').length, 20);
    assert.ok(document.querySelector('.chart-pending'));
    assert.equal(document.querySelector('.chart-pending').textContent, '');
    assert.equal(document.querySelector('.export-button').getAttribute('aria-disabled'), 'true');
    assert.equal(document.querySelector('.study-header-actions button').disabled, true);
    assert.doesNotMatch(document.body.textContent, /could not be loaded|Split-normalized EPS is unavailable/);
    const input = document.querySelector('[aria-label="Earnings per share annual forecast percentage"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '12');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => root.render(React.createElement(StudyPage, { ...props, fundamentalsStatus: 'error', fundamentalsError: 'Temporary connection problem' })));
    assert.equal(input.value, '12');
    assert.ok(document.querySelector('.chart-pending'));
    assert.match(document.querySelector('[role="alert"]').textContent, /Temporary connection problem/);
    await React.act(async () => document.querySelector('[role="alert"] button').click());
    assert.equal(retries, 1);
    const loaded = { ...study, financialCurrency: 'USD', priceCurrency: 'USD', epsAdjustment: { status: 'normalized' },
      annual: [{ periodEnd: '2025-12-31', sales: 100e6, eps: 2, pretaxProfit: 20e6, salesSource: null, epsSource: null, pretaxProfitSource: null }],
      sources: { sec: { status: 'ok' }, yfinance: { status: 'ok' } } };
    await React.act(async () => root.render(React.createElement(StudyPage, { ...props, study: loaded, fundamentalsStatus: 'idle' })));
    assert.equal(document.querySelector('[aria-label="Earnings per share annual forecast percentage"]'), input);
    assert.equal(input.value, '12');
    assert.equal(document.querySelectorAll('.pending-period').length, 0);
    assert.equal(document.querySelector('.chart-pending'), null);
    assert.equal(document.querySelector('.study-background-status'), null);
    assert.equal(document.querySelector('.export-button').getAttribute('href'), '/api/studies/pending-test?download=1');
    assert.match(document.querySelector('[aria-labelledby="financial-table-title"]').textContent, /100/);
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    globalThis.fetch = originalFetch;
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
