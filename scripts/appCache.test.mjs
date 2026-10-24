import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('fetched and cached reports retain the full inputs for open FCF/share dots', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: `http://localhost/#/study/${id}` });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 560, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 560 });
  const annual = { FiscalYear: 2020, AsOfDataDate: '2020-12-31', Sales: 100, EPS: 1, PTP: 10, BookValue: 5, CashFlow: 2, FreeCashFlow: 20, SharesOut: 10,
    EPSSplitFactor: 1, Sources: { Sales: null, EPS: null, PTP: null, SharesOut: { Start: '2020-01-01', End: '2020-12-31' } } };
  const quarters = [2020, 2021].flatMap(year => [1, 2].map(quarter => ({ ...annual, FiscalYear: year, QuarterNo: quarter, Form: '10-Q',
    AsOfDataDate: `${year}-${quarter === 1 ? '03-31' : '06-30'}`, Sales: year === 2020 ? 20 : 30, EPS: 0.3, PTP: 3, FreeCashFlow: year === 2020 ? 4 : 6,
    Sources: { ...annual.Sources, SharesOut: { Start: `${year}-${quarter === 1 ? '01-01' : '04-01'}`, End: `${year}-${quarter === 1 ? '03-31' : '06-30'}` } },
  })));
  const source = { Status: 'ok', URL: '', RetrievedAt: null, Error: null };
  const documentData = { SchemaVersion: 1, Study: { StudyID: id, DateCreated: '2021-08-01T00:00:00Z' },
    Company: { Ticker: 'TEST', CompanyName: 'Test Company', CentralIndexKey: '1', ExchangeType: 'Nasdaq' }, AnnualData: [annual], QuarterlyData: quarters,
    DailyPrices: [{ Date: '2021-06-30', Close: 10 }], ComputedValues: { SalesGrowthRate: null, EPSGrowthRate: null, PTPGrowthRate: null },
    Metadata: { FinancialCurrency: 'USD', PriceCurrency: 'USD', Warnings: [], Sources: { SEC: source, YahooFinance: source }, EPSAdjustment: { Status: 'normalized', Events: [] } },
  };
  let fetches = 0;
  let marketQuote = { currency: 'USD', regular: { price: 100, change: 2, percent: 2.04, time: '2021-08-02T20:00:00Z' }, postMarket: { price: 101.5, change: 1.5, percent: 1.5, time: '2021-08-02T22:00:00Z' }, retrievedAt: '2021-08-02T22:00:00Z' };
  globalThis.fetch = async url => { const isStudy = String(url).startsWith('/api/studies/'); if (isStudy) fetches++; return { ok: true, headers: { get: () => 'application/json' }, json: async () => isStudy ? documentData : String(url).startsWith('/api/quotes/') ? marketQuote : { data: [] } }; };
  const dir = await mkdtemp(new URL('../.data/app-test-', import.meta.url));
  await build({ entryPoints: ['src/App.tsx'], outfile: `${dir}/App.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'import.meta.env.BASE_URL': JSON.stringify('/') } });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import(pathToFileURL(`${dir}/App.mjs`).href);
  const root = createRoot(document.getElementById('root'));
  const settle = async () => { await React.act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); }); };
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await settle();
    const selector = 'circle.draggable-series-freeCashFlowPerShare[data-period="quarterly"]';
    assert.equal(document.querySelectorAll(selector).length, 2);
    assert.equal(document.querySelector('.post-market-quote b').textContent, '$101.50');
    assert.match(document.querySelector('.post-market-quote').textContent, /\+1.50 \(\+1.50%\)/);
    await React.act(async () => document.querySelector('.study-nav .back-button').click());
    await settle();
    await React.act(async () => { window.location.hash = `/study/${id}`; });
    await settle();
    await settle();
    assert.equal(document.querySelectorAll(selector).length, 2);
    marketQuote = { ...marketQuote, postMarket: { ...marketQuote.postMarket, price: 99, change: -1, percent: -1 } };
    await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    await settle();
    assert.equal(document.querySelector('.post-market-quote b').textContent, '$99.00');
    assert.match(document.querySelector('.post-market-quote .negative').textContent, /-1.00 \(-1.00%\)/);
    assert.equal(fetches, 1, 'Returning to a cached report preserves all TTM inputs without another request');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
