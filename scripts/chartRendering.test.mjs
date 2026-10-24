import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('year exclusions update the existing chart without adding or replacing chart surfaces', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 560, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 560 });
  window.SVGElement.prototype.getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(window.SVGSVGElement.prototype, 'viewBox', { configurable: true, get: () => ({ baseVal: { width: 1000, height: 560 } }) });
  const dir = await mkdtemp(new URL('../.data/chart-test-', import.meta.url));
  const outfile = `${dir}/StudyPage.mjs`;
  await build({ entryPoints: ['src/StudyPage.tsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: StudyPage } = await import(pathToFileURL(outfile).href);
  const source = { status: 'ok', url: '', retrievedAt: null, error: null };
  const study = { id: 'render-test', company: { ticker: 'TEST', name: 'Test Company', exchange: 'Nasdaq', cik: 1 },
    overview: { Description: 'The company develops logistics software.\nIts customers use its products to manage operations worldwide.' },
    createdAt: '2026-10-23T00:00:00Z', financialCurrency: 'USD', priceCurrency: 'USD', warnings: [],
    epsAdjustment: { status: 'normalized' }, sources: { sec: source, yfinance: source },
    annual: Array.from({ length: 5 }, (_, i) => ({ periodEnd: `${2016 + i}-12-31`, sales: (100 + i * 10) * 1e6, eps: 1 + i / 10,
      pretaxProfit: (10 + i) * 1e6, bookValuePerShare: 5 + i, freeCashFlowPerShare: 2 + i / 10,
      highPrice: 20 + i, lowPrice: 10 + i, dividendPerShare: 0.1, freeCashFlow: (2 + i / 10) * 10, dilutedShares: 10, shareDays: 365, epsSplitFactor: 1, salesSource: null, epsSource: null, pretaxProfitSource: null })),
    prices: Array.from({ length: 5 }, (_, i) => ({ date: `${2016 + i}-12-31`, close: 10 + i })),
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(StudyPage, { study, onBack() {}, onRefresh() {} }))); });
    await React.act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    const chart = document.querySelector('.recharts-wrapper');
    assert.ok(chart);
    assert.deepEqual([...document.querySelectorAll('.chart-series-item>span')].map(label => label.textContent), ['Sales', 'EPS', 'PTP', 'BV/Share', 'FCF/Share', 'Price']);
    const companyPanel = document.querySelector('.company-description-panel');
    assert.equal(document.querySelector('.company-overview .company-description'), null);
    assert.equal(companyPanel.previousElementSibling.className, 'chart-main');
    assert.equal(companyPanel.querySelectorAll('p').length, 2);
    assert.match(companyPanel.textContent, /manage operations worldwide/);
    const surface = chart.querySelector('svg.recharts-surface');
    assert.equal(chart.querySelectorAll('[data-axis-label]').length, 0);
    assert.ok(!document.body.textContent.includes('Drag a line vertically'));
    assert.equal(document.querySelector('.chart-footnote'), null);
    const salesDot = chart.querySelector('circle.draggable-series-sales');
    assert.equal(salesDot.getAttribute('r'), '2.2');
    assert.match(salesDot.querySelector('title').textContent, /Sales/);
    await React.act(async () => {
      chart.querySelector('[data-testid="line-hover-area"]').dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: Number(salesDot.getAttribute('cx')), clientY: Number(salesDot.getAttribute('cy')) }));
      await new Promise(resolve => window.requestAnimationFrame(resolve));
    });
    assert.match(document.querySelector('[role="tooltip"]').textContent, /Sales/);
    for (let year = 2026; year <= 2031; year++) {
      const tick = chart.querySelector(`.year-tick[aria-label*="${year}"]`);
      assert.ok(tick, `The axis includes ${year}`);
      assert.equal(tick.querySelector('text').textContent, String(year).slice(-2));
    }
    const actual = chart.querySelector('.draggable-series-sales path.recharts-line-curve[stroke-width="1.5"]');
    const originalPath = actual?.getAttribute('d');
    assert.ok(originalPath);
    const financialKeys = ['sales', 'eps', 'pretaxProfit', 'freeCashFlowPerShare', 'bookValuePerShare'];
    const originalDots = new Map(financialKeys.map(key => [key, [...chart.querySelectorAll(`circle.draggable-series-${key}`)].map(dot => [dot.getAttribute('cx'), dot.getAttribute('cy')])]));
    for (const key of financialKeys) {
      for (const dot of chart.querySelectorAll(`circle.draggable-series-${key}[data-period="annual"]`)) {
        const year = dot.getAttribute('data-fiscal-year');
        const tick = chart.querySelector(`.year-tick[aria-label*="${year}"]`);
        const x = Number(tick.getAttribute('transform').match(/translate\(([^,]+)/)[1]);
        assert.equal(Number(dot.getAttribute('cx')), x, `${key} FY${year} must align exactly with its year tick`);
      }
    }
    const table = document.querySelector('[aria-labelledby="financial-table-title"]');
    assert.equal(table.querySelectorAll('tbody tr').length, 5);
    assert.match(table.querySelectorAll('tbody tr')[3].textContent, /FCF \/ Share/);
    assert.equal(table.querySelectorAll('tbody tr')[3].querySelector('td').textContent, '2.00');
    assert.match(table.querySelectorAll('tbody tr')[4].textContent, /BV \/ Share/);
    assert.equal(table.querySelectorAll('tbody tr')[4].querySelector('td').textContent, '5.00');
    const excludedYears = new Set();
    const originalGrowth = [...document.querySelectorAll('[aria-labelledby="financial-table-title"] tbody .calculated-column')].map(cell => cell.textContent);
    for (const year of [2016, 2017, 2018, 2019, 2020, 2020, 2019, 2018, 2017, 2016]) {
      const tick = document.querySelector(`.year-tick[aria-label*="${year}"]`);
      assert.ok(tick);
      await React.act(async () => { tick.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      if (excludedYears.has(year)) excludedYears.delete(year);
      else excludedYears.add(year);
      const included = study.annual.filter(row => !excludedYears.has(Number(row.periodEnd.slice(0, 4))));
      const tableRows = [...document.querySelectorAll('[aria-labelledby="financial-table-title"] tbody tr')];
      for (const [index, row] of tableRows.entries()) {
        const key = financialKeys[index];
        for (let i = 0; i < study.annual.length; i++) {
          const cell = row.querySelectorAll('td')[i];
          assert.equal(Boolean(cell.querySelector('del')), excludedYears.has(2016 + i), `year ${year}, row ${index}, cell ${i}: ${cell.outerHTML}`);
        }
        let expected = '—';
        if (included.length >= 2) {
          const n = included.length;
          const x = included.map(point => Number(point.periodEnd.slice(0, 4)) - 2016);
          const y = included.map(point => Math.log(point[key]));
          const sum = values => values.reduce((total, value) => total + value, 0);
          const slope = (n * sum(x.map((value, i) => value * y[i])) - sum(x) * sum(y)) / (n * sum(x.map(value => value * value)) - sum(x) ** 2);
          expected = `${(Math.expm1(slope) * 100).toFixed(1)}%`;
        }
        assert.equal(row.querySelector('.calculated-column').textContent, expected);
      }
      assert.equal(document.querySelectorAll('.recharts-wrapper').length, 1);
      assert.equal(document.querySelector('.recharts-wrapper'), chart);
      assert.equal(chart.querySelectorAll('svg.recharts-surface').length, 1);
      assert.equal(chart.querySelector('svg.recharts-surface'), surface);
      const trend = chart.querySelector('.draggable-series-sales path.recharts-line-curve[stroke-width="1"]');
      assert.ok(trend, 'The trend remains visible while years are crossed out');
      const trendX = [...trend.getAttribute('d').matchAll(/[ML]([^,]+)/g)].map(match => Number(match[1]));
      const yearX = year => Number(chart.querySelector(`.year-tick[aria-label*="${year}"]`).getAttribute('transform').match(/translate\(([^,]+)/)[1]);
      assert.equal(trendX[0], yearX(2016));
      assert.equal(trendX.at(-1), yearX(2020));
      if (included.length < 2) assert.ok([...document.querySelectorAll('.line-toggles button')].some(button => button.title.includes('Reference fit')));
      for (const key of financialKeys) {
        const dots = [...chart.querySelectorAll(`circle.draggable-series-${key}`)];
        assert.equal(dots.length, included.length);
        assert.deepEqual(dots.map(dot => [dot.getAttribute('cx'), dot.getAttribute('cy')]), originalDots.get(key).filter((_, index) => !excludedYears.has(2016 + index)));
      }
    }
    assert.equal(chart.querySelector('.draggable-series-sales path.recharts-line-curve[stroke-width="1.5"]')?.getAttribute('d'), originalPath);
    assert.deepEqual([...document.querySelectorAll('[aria-labelledby="financial-table-title"] tbody .calculated-column')].map(cell => cell.textContent), originalGrowth);
    const middleYear = document.querySelector('.year-tick[aria-label*="2018"]');
    await React.act(async () => { middleYear.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    for (const key of financialKeys) {
      const connectedPath = chart.querySelector(`.draggable-series-${key} path.recharts-line-curve[stroke-width="1.5"]`).getAttribute('d');
      assert.equal((connectedPath.match(/M/g) || []).length, 1, 'Excluding an interior year keeps a single connected actual line');
      assert.equal((connectedPath.match(/L/g) || []).length, 3, 'The four remaining observations connect directly');
      assert.equal(chart.querySelectorAll(`circle.draggable-series-${key}[data-fiscal-year="2018"]`).length, 0);
      const coordinates = [...connectedPath.matchAll(/[ML]([^,]+),([^ML]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
      const expected = originalDots.get(key).filter((_, index) => index !== 2);
      for (let index = 0; index < coordinates.length; index++) {
        assert.ok(Math.abs(coordinates[index][0] - Number(expected[index][0])) < 0.001);
        assert.ok(Math.abs(coordinates[index][1] - Number(expected[index][1])) < 0.001);
      }
    }
    await React.act(async () => { document.querySelector('.year-tick[aria-label*="2018"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const quarterStudy = { ...study, quarterly: [
      { ...study.annual[0], periodEnd: '2019-03-31', fiscalYear: 2019, quarter: 1 },
      { ...study.annual[4], periodEnd: '2020-03-31', fiscalYear: 2020, quarter: 1 },
      { ...study.annual[4], periodEnd: '2020-06-30', fiscalYear: 2020, quarter: 2 },
      { ...study.annual[4], periodEnd: '2021-03-31', fiscalYear: 2021, quarter: 1, form: '10-Q' },
      { ...study.annual[4], periodEnd: '2021-06-30', fiscalYear: 2021, quarter: 2, form: '6-K/A', epsSplitFactor: null },
      { ...study.annual[4], periodEnd: '2021-12-31', fiscalYear: 2021, quarter: 4, form: '10-K' },
    ].map(row => ({ ...row, shareDays: 91 })) };
    await React.act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(StudyPage, { study: quarterStudy, onBack() {}, onRefresh() {} }))); });
    assert.equal(document.querySelectorAll('.recharts-wrapper').length, 1);
    for (const key of financialKeys) {
      const annualDots = chart.querySelectorAll(`circle.draggable-series-${key}[data-period="annual"]`);
      const quarterlyDots = chart.querySelectorAll(`circle.draggable-series-${key}[data-period="quarterly"]`);
      assert.equal(annualDots.length, 5);
      assert.equal(quarterlyDots.length, key === 'eps' ? 1 : 2);
      for (const dot of annualDots) assert.equal(dot.getAttribute('fill'), dot.getAttribute('stroke'));
      for (const dot of quarterlyDots) { assert.match(dot.getAttribute('fill'), /^#[0-9a-f]{6}$/i); assert.notEqual(dot.getAttribute('fill'), '#fff'); assert.notEqual(dot.getAttribute('fill'), dot.getAttribute('stroke')); assert.equal(dot.getAttribute('r'), '2.8'); }
      const salesX = [...chart.querySelectorAll('circle.draggable-series-sales[data-period="quarterly"]')].map(dot => dot.getAttribute('cx'));
      assert.deepEqual([...quarterlyDots].map(dot => dot.getAttribute('cx')), key === 'eps' ? salesX.slice(0, 1) : salesX);
    }
    assert.deepEqual([...table.querySelectorAll('tbody .calculated-column')].map(cell => cell.textContent), originalGrowth, 'Quarterly values must not alter annual growth');
    await React.act(async () => { document.querySelector('.year-tick[aria-label*="2021"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    assert.equal(chart.querySelectorAll('circle[data-period="quarterly"]').length, 0);
    await React.act(async () => { document.querySelector('.year-tick[aria-label*="2021"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const annualStudy = { ...quarterStudy, annual: [...study.annual, { ...study.annual[4], periodEnd: '2021-12-31' }] };
    await React.act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(StudyPage, { study: annualStudy, onBack() {}, onRefresh() {} }))); });
    assert.equal(chart.querySelectorAll('circle[data-period="quarterly"]').length, 0, 'A new annual report replaces the prior interim quarter markers');
    assert.equal(chart.querySelectorAll('circle.draggable-series-sales[data-period="annual"]').length, 6);
    assert.equal(document.querySelector('[aria-label="Inspect a chart line"]'), null);
    assert.ok(![...document.querySelectorAll('button')].some(button => button.textContent === 'Show all'));
    const sidebar = document.querySelector('.chart-series-legend');
    assert.match(sidebar.querySelector('.legend-control-key').textContent, /HA\/SA: Hide\/Show Actual/);
    const actualToggle = () => [...sidebar.querySelectorAll('.line-toggles button')].find(button => button.getAttribute('aria-label').endsWith('Sales · Actual'));
    const fitToggle = () => [...sidebar.querySelectorAll('.line-toggles button')].find(button => button.getAttribute('aria-label').endsWith('Sales · Regression'));
    await React.act(async () => actualToggle().click());
    assert.equal(actualToggle().textContent, 'SA');
    assert.equal(actualToggle().getAttribute('aria-pressed'), 'false');
    assert.equal(chart.querySelectorAll('circle.draggable-series-sales').length, 0);
    assert.equal(fitToggle().textContent, 'HF');
    await React.act(async () => fitToggle().click());
    assert.equal(fitToggle().textContent, 'SF');
    await React.act(async () => document.querySelector('.year-tick[aria-label*="2020"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const reset = [...sidebar.querySelectorAll('button')].find(button => button.textContent === 'Reset chart');
    assert.ok(reset, 'Reset remains inside the left sidebar');
    await React.act(async () => reset.click());
    assert.equal(actualToggle().textContent, 'HA');
    assert.equal(fitToggle().textContent, 'HF');
    assert.equal(chart.querySelectorAll('circle.draggable-series-sales[data-period="annual"]').length, 6);
    assert.equal(document.querySelectorAll('.year-tick.is-excluded').length, 0);
    assert.equal(document.querySelectorAll('.recharts-wrapper').length, 1);
    const valuationTab = document.getElementById('tab-valuation');
    const fundamentalsTab = document.getElementById('tab-fundamentals');
    assert.equal(fundamentalsTab.getAttribute('aria-selected'), 'true');
    await React.act(async () => valuationTab.click());
    const valuationPanel = document.getElementById('panel-valuation');
    assert.equal(valuationPanel.hidden, false);
    assert.equal(document.getElementById('panel-fundamentals').hidden, true);
    assert.equal(valuationPanel.querySelectorAll('tbody tr').length, 10);
    const latestRow = [...valuationPanel.querySelectorAll('tbody tr')].find(row => row.querySelector('th').textContent === '2021');
    assert.equal(latestRow.querySelectorAll('td')[3].textContent, '17.1');
    await React.act(async () => valuationPanel.querySelector('input[value="5"]').click());
    assert.equal(valuationPanel.querySelectorAll('tbody tr').length, 5);
    await React.act(async () => valuationTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    assert.equal(document.getElementById('panel-fundamentals').hidden, false);
    assert.equal(fundamentalsTab.getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('.recharts-wrapper'), chart);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
