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
    return { ok: true, json: async () => ({ data: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq'], [789019, 'Microsoft Corporation', 'MSFT', 'Nasdaq'], ...Array.from({ length: 12 }, (_, index) => [1000 + index, `Test Company ${index}`, `TEST${index}`, 'Nasdaq'])] }) };
  };
  const dir = await mkdtemp(new URL('../.data/home-test-', import.meta.url));
  await build({ stdin: { contents: "export {default as App} from './src/App'; export {default as SearchPage} from './src/SearchPage';", resolveDir: process.cwd(), loader: 'tsx' }, outfile: `${dir}/home.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'import.meta.env.BASE_URL': JSON.stringify('/') } });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App, SearchPage } = await import(pathToFileURL(`${dir}/home.mjs`).href);
  const root = createRoot(document.getElementById('root'));
  try {
    let selected;
    const preloads = [];
    await React.act(async () => root.render(React.createElement(SearchPage, { onSelect: company => { selected = company; }, onPreload: company => { preloads.push(company.ticker); } })));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    assert.match(document.querySelector('.home-methodology').textContent, /Welcome to the Fairfax Investing Group Research Dashboard!/);
    const dashboard = document.querySelector('.portfolio-dashboard');
    assert.ok(dashboard);
    assert.equal(document.querySelectorAll('.home-brand-logo').length, 1);
    assert.equal(dashboard.querySelector('img'), null);
    assert.equal(document.getElementById('portfolio-title'), null);
    assert.equal(document.getElementById('portfolio-positions-title'), null);
    assert.equal(dashboard.querySelectorAll('.portfolio-charts .recharts-wrapper').length, 1);
    assert.equal(dashboard.querySelector('.portfolio-charts .portfolio-performance-status'), null);
    const periods = [...dashboard.querySelectorAll('.portfolio-period button')];
    assert.deepEqual(periods.map(button => button.textContent), ['Lifetime returns', 'YTD', '1M', '3M']);
    assert.equal(periods[0].getAttribute('aria-pressed'), 'true');
    await React.act(async () => periods[2].click());
    assert.equal(periods[2].getAttribute('aria-pressed'), 'true');
    await React.act(async () => periods[0].click());
    assert.ok(dashboard.querySelector('.portfolio-chart [data-testid="return-label-club"]'));
    assert.equal(dashboard.querySelector('[data-testid="return-label-club"]').textContent, 'Fund return: 11.14%');
    assert.equal(dashboard.querySelector('[data-testid="return-label-benchmark"]').textContent, 'S&P return: 9.24%');
    const fundLabel = dashboard.querySelector('[data-testid="return-label-club"]');
    const benchmarkLabel = dashboard.querySelector('[data-testid="return-label-benchmark"]');
    assert.ok(Number(fundLabel.getAttribute('y')) < Number(fundLabel.parentNode.querySelector('circle').getAttribute('cy')));
    assert.ok(Number(benchmarkLabel.getAttribute('y')) > Number(benchmarkLabel.parentNode.querySelector('circle').getAttribute('cy')));
    assert.equal(document.getElementById('portfolio-performance-title').textContent, 'Fairfax Investing Group “L/O” Fund vs. S&P 500');

    assert.equal(dashboard.querySelectorAll('.portfolio-holdings tbody tr').length, 10);
    assert.match(dashboard.querySelector('.portfolio-summary').textContent, /\$13,525\.96/);
    const msft = [...dashboard.querySelectorAll('.portfolio-holdings tbody tr')].find(row => row.querySelector('th').textContent === 'MSFT');
    assert.equal(msft.querySelector('time').dateTime, '2026-02-17');
    assert.match(msft.textContent, /avg down/);
    const holdingRows = () => [...dashboard.querySelectorAll('.portfolio-holdings tbody tr')];
    const expectedTickers = (key, descending) => [...portfolioData.holdings].sort((a, b) => (a[key] - b[key]) * (descending ? -1 : 1)).map(item => item.ticker);
    const shownTickers = () => holdingRows().map(row => row.querySelector('th').textContent);
    assert.deepEqual(shownTickers(), expectedTickers('gain', true));
    const marketSort = [...dashboard.querySelectorAll('.portfolio-holdings thead button')].find(button => button.textContent.startsWith('Market value'));
    await React.act(async () => marketSort.click());
    assert.deepEqual(shownTickers(), expectedTickers('marketValue', true));
    assert.equal(marketSort.querySelector('.portfolio-sort-arrows').textContent, '↓');
    await React.act(async () => marketSort.click());
    assert.deepEqual(shownTickers(), expectedTickers('marketValue', false));
    assert.equal(marketSort.querySelector('.portfolio-sort-arrows').textContent, '↑');
    assert.equal(holdingRows()[0].querySelector('.portfolio-history-cell svg').getAttribute('preserveAspectRatio'), 'none');
    assert.match(dashboard.querySelector('.portfolio-risk-box').textContent, /Beta vs. S&P 500/);
    assert.equal(dashboard.querySelectorAll('.portfolio-risk-box dl>div').length, 6);
    assert.doesNotMatch(dashboard.querySelector('.portfolio-risk-box').textContent, /Cash weight|Top 5 holdings weight/);
    assert.ok(dashboard.querySelector('#portfolio-diversification-title'));
    assert.equal(dashboard.querySelectorAll('.portfolio-allocation-donut').length, 2);
    const tiles = [...dashboard.querySelectorAll('.portfolio-heatmap rect')];
    assert.equal(tiles.length, portfolioData.holdings.length + 1);
    assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + Number(tile.getAttribute('width')) * Number(tile.getAttribute('height')), 0) - 360 * 190) < 1e-6);
    const totalValue = portfolioData.summary.cash + portfolioData.holdings.reduce((sum, holding) => sum + holding.marketValue, 0);
    for (const holding of portfolioData.holdings) {
      const group = [...dashboard.querySelectorAll('.portfolio-heatmap g[tabindex]')].find(tile => tile.getAttribute('aria-label').startsWith(`${holding.ticker}:`));
      const rect = group.querySelector('rect');
      const width = Number(rect.getAttribute('width')), height = Number(rect.getAttribute('height'));
      assert.ok(Math.abs(width * height / (360 * 190) - holding.marketValue / totalValue) < 1e-10);
      if (['GOOGL', 'ASTS'].includes(holding.ticker)) {
        assert.ok(width >= 40, `${holding.ticker} needs room for its label`);
        assert.ok(height >= 22);
      }
    }
    assert.match(dashboard.querySelector('.portfolio-heatmap').textContent, /CASH/);
    assert.equal(dashboard.querySelectorAll('.portfolio-donut-center,.portfolio-donut-caption').length, 0);
    const stockTile = [...dashboard.querySelectorAll('.portfolio-heatmap g[tabindex]')].find(tile => tile.getAttribute('aria-label').startsWith('MSFT:'));
    assert.equal(stockTile.querySelectorAll('text').length, 0);
    assert.equal(dashboard.querySelectorAll('.portfolio-heatmap-labels span').length, portfolioData.holdings.length + 1);
    await React.act(async () => stockTile.focus());
    assert.match(dashboard.querySelector('.portfolio-heatmap-tooltip').textContent, /Return:.*Purchased: Feb 17, 2026/);
    await React.act(async () => stockTile.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 100, clientY: 50, bubbles: true })));
    assert.equal(dashboard.querySelector('.portfolio-heatmap-tooltip').style.left, '110px');
    await React.act(async () => dashboard.querySelector('.portfolio-pie-slice').focus());
    assert.match(dashboard.querySelector('.portfolio-allocation-tooltip').textContent, /MSFT/);
    assert.match(document.getElementById('company-search-help').textContent, /select a match to open its stock research/);
    assert.match(dashboard.querySelector('.portfolio-risk-box').textContent, /Sharpe ratio/);
    assert.match(dashboard.querySelector('[data-testid="portfolio-day-change"]').textContent, /^[+-]?\d+\.\d{2}%$/);
    await React.act(async () => dashboard.querySelector('.portfolio-partner-button').click());
    assert.equal(dashboard.querySelectorAll('.portfolio-partner-detail tbody tr').length, 4);
    await React.act(async () => msft.querySelector('.portfolio-ticker').click());
    assert.equal(selected.ticker, 'MSFT');
    portfolioData = { ...portfolioData, lastSuccessfulAt: '2026-10-23T20:16:00Z', summary: { ...portfolioData.summary, portfolioValue: 14000, portfolioReturn: .125, benchmarkReturn: .1 }, performance: portfolioData.performance.map((point, index, points) => index === points.length - 1 ? { ...point, club: .125, benchmark: .1 } : point), refresh: { status: 'ready', error: null, retryAt: null, nextRefreshAt: '2026-10-26T20:15:00Z' } };
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.match(dashboard.querySelector('.portfolio-summary').textContent, /\$14,000\.00/);
    assert.match(dashboard.querySelector('.portfolio-asof').textContent, /End-of-day portfolio/);
    assert.match(dashboard.querySelector('.portfolio-asof').textContent, /4:15/);
    assert.equal(dashboard.querySelector('[data-testid="return-label-club"]').textContent, 'Fund return: 12.50%');
    assert.equal(dashboard.querySelector('[data-testid="return-label-benchmark"]').textContent, 'S&P return: 10.00%');
    assert.equal(msft.querySelector('time').dateTime, '2026-02-17');
    assert.ok(document.querySelector('.home-login-form'));
    assert.ok(document.getElementById('home-login-email'));
    assert.ok(document.querySelector('.home-login-actions button').disabled);
    const input = document.getElementById('company-search');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'test');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('.company-result').length, 10);
    const topFive = ['TEST0', 'TEST1', 'TEST10', 'TEST11', 'TEST2'];
    assert.deepEqual(preloads, [], 'Preloading waits for a pause in typing');
    assert.equal(document.getElementById('search-results').hidden, false);
    await React.act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    assert.equal(input.getAttribute('aria-activedescendant'), 'company-option-0');
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
    assert.deepEqual(preloads, topFive, 'Typing pause preloads the top five matches without needing a highlight');
    await React.act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(selected.ticker, 'TEST0');
    assert.equal(document.getElementById('search-results').hidden, true);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'apple');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('.company-result').length, 1);
    // Continue typing before the Apple debounce expires: only Microsoft should warm.
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'msft');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
    assert.deepEqual(preloads, [...topFive, 'MSFT'], 'More typing cancels the previous debounce');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'apple');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
    assert.deepEqual(preloads, [...topFive, 'MSFT', 'AAPL'], 'Fewer than five matches preload all available results');
    const apple = document.querySelector('.company-result');
    await React.act(async () => {
      apple.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 70));
    });
    assert.deepEqual(preloads, [...topFive, 'MSFT', 'AAPL'], 'Hover and keyboard highlighting do not start extra preloads');
    await React.act(async () => input.focus());
    const mouseDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    await React.act(async () => {
      // Model Safari's mouse focus default: blur to no target if not prevented.
      apple.dispatchEvent(mouseDown);
      if (!mouseDown.defaultPrevented) input.blur();
    });
    assert.equal(document.getElementById('search-results').hidden, false, 'Results must remain visible between mouse down and click');
    assert.equal(document.activeElement, input, 'Mouse selection preserves combobox focus');
    await React.act(async () => apple.click());
    assert.equal(selected.ticker, 'AAPL');
    assert.equal(document.getElementById('search-results').hidden, true);
    // Genuine focus movement outside the search should still close the popup.
    await React.act(async () => {
      input.focus();
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    assert.equal(document.getElementById('search-results').hidden, false);
    await React.act(async () => document.getElementById('home-login-email').focus());
    assert.equal(document.getElementById('search-results').hidden, true);
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
