import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('home company search selects the correct issuer and login opens without a study request', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 560, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 560 });
  let portfolioData = JSON.parse(await readFile(new URL('../src/data/portfolio.json', import.meta.url), 'utf8'));
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url) === '/api/portfolio') return { ok: true, json: async () => portfolioData };
    return { ok: true, json: async () => ({ data: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq'], [789019, 'Microsoft Corporation', 'MSFT', 'Nasdaq']] }) };
  };
  const dir = await mkdtemp(new URL('../.data/home-test-', import.meta.url));
  await build({ stdin: { contents: "export {default as App} from './src/App'; export {default as SearchPage} from './src/SearchPage';", resolveDir: process.cwd(), loader: 'tsx' }, outfile: `${dir}/home.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'import.meta.env.BASE_URL': JSON.stringify('/') } });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App, SearchPage } = await import(pathToFileURL(`${dir}/home.mjs`).href);
  const root = createRoot(document.getElementById('root'));
  try {
    let selected;
    await React.act(async () => root.render(React.createElement(SearchPage, { onSelect: company => { selected = company; } })));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    assert.match(document.querySelector('.home-methodology').textContent, /Welcome to the Fairfax Investing Group Research Dashboard!/);
    const dashboard = document.querySelector('.portfolio-dashboard');
    assert.ok(dashboard);
    assert.equal(document.querySelectorAll('.home-brand-logo').length, 1);
    assert.equal(dashboard.querySelector('img'), null);
    assert.equal(document.getElementById('portfolio-title'), null);
    assert.equal(document.getElementById('portfolio-positions-title'), null);
    assert.equal(dashboard.querySelectorAll('.portfolio-charts .recharts-wrapper').length, 1);
    assert.equal(dashboard.querySelector('[data-testid="return-label-club"]').textContent, 'Club return: 11.14%');
    assert.equal(dashboard.querySelector('[data-testid="return-label-benchmark"]').textContent, 'S&P return: 9.24%');
    assert.equal(dashboard.querySelectorAll('.portfolio-holdings tbody tr').length, 10);
    assert.match(dashboard.querySelector('.portfolio-summary').textContent, /\$13,525\.96/);
    const msft = [...dashboard.querySelectorAll('.portfolio-holdings tbody tr')].find(row => row.querySelector('th').textContent === 'MSFT');
    assert.equal(msft.querySelector('time').dateTime, '2026-02-17');
    assert.match(msft.textContent, /avg down/);
    await React.act(async () => dashboard.querySelector('.portfolio-partner-button').click());
    assert.equal(dashboard.querySelectorAll('.portfolio-partner-detail tbody tr').length, 4);
    await React.act(async () => msft.querySelector('.portfolio-ticker').click());
    assert.equal(selected.ticker, 'MSFT');
    portfolioData = { ...portfolioData, lastSuccessfulAt: '2026-10-23T20:16:00Z', summary: { ...portfolioData.summary, portfolioValue: 14000, portfolioReturn: .125, benchmarkReturn: .1 }, performance: portfolioData.performance.map((point, index, points) => index === points.length - 1 ? { ...point, club: .125, benchmark: .1 } : point), refresh: { status: 'ready', error: null, retryAt: null, nextRefreshAt: '2026-10-26T20:15:00Z' } };
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.match(dashboard.querySelector('.portfolio-summary').textContent, /\$14,000\.00/);
    assert.match(dashboard.querySelector('.portfolio-asof').textContent, /End-of-day portfolio/);
    assert.match(dashboard.querySelector('.portfolio-asof').textContent, /4:15/);
    assert.equal(dashboard.querySelector('[data-testid="return-label-club"]').textContent, 'Club return: 12.50%');
    assert.equal(dashboard.querySelector('[data-testid="return-label-benchmark"]').textContent, 'S&P return: 10.00%');
    assert.equal(msft.querySelector('time').dateTime, '2026-02-17');
    assert.ok(document.querySelector('.home-login-form'));
    assert.ok(document.getElementById('home-login-email'));
    assert.ok(document.querySelector('.home-login-actions button').disabled);
    const input = document.getElementById('company-search');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'apple');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('.company-result').length, 1);
    await React.act(async () => document.querySelector('.company-result').click());
    assert.equal(selected.ticker, 'AAPL');
    window.location.hash = '/login';
    await React.act(async () => root.render(React.createElement(App)));
    assert.equal(document.getElementById('login-title').textContent, 'Log in');
    assert.ok(document.querySelector('.login-submit').disabled);
    await React.act(async () => document.querySelector('.login-password-field button').click());
    assert.equal(document.getElementById('login-password').type, 'text');
    assert.ok(requests.every(url => !url.startsWith('/api/studies')));
    await React.act(async () => {
      window.location.hash = '';
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    });
    assert.ok(document.querySelector('.home-topbar'));
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
