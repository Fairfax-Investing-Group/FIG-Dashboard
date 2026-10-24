import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/valuationMath.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { peRatio, valuationRows, valuationAverage, currentValuation } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const row = (year, overrides = {}) => ({ fiscalYear: year, periodEnd: `${year}-12-31`, sales: 100, eps: 2, pretaxProfit: 10, highPrice: 20, lowPrice: 10, dividendPerShare: 0.5, ...overrides });

test('historical P/E, payout and high yield follow the reference formulas', () => {
  const value = valuationRows([row(2025)], true, 1)[0];
  assert.equal(value.highPE, 10);
  assert.equal(value.lowPE, 5);
  assert.equal(value.payout, 25);
  assert.equal(value.highYield, 5);
  assert.equal(valuationRows([row(2025, { highPE: 10.1, lowPE: 5.1 })], true, 1)[0].highPE, 10.1);
});

test('missing years remain empty and averages use the requested fiscal-year window', () => {
  const values = valuationRows([row(2016, { highPE: 100 }), row(2022, { highPE: 12 }), row(2025, { highPE: 18 })], true, 10);
  assert.equal(values.length, 10);
  assert.equal(values.find(row => row.year === 2023).eps, null);
  assert.equal(valuationAverage(values, 5).highPE, 15);
  assert.equal(valuationAverage(values, 10).highPE, 130 / 3);
});

test('nonpositive EPS and mismatched currencies do not produce misleading ratios', () => {
  assert.equal(peRatio(100, 0), null);
  assert.equal(peRatio(100, -2), null);
  assert.equal(peRatio(Infinity, 2), null);
  const loss = valuationRows([row(2025, { eps: -1, highPE: -20 })], true, 1)[0];
  assert.equal(loss.highPE, null);
  assert.equal(loss.payout, null);
  const mismatch = valuationRows([row(2025)], false, 1)[0];
  assert.equal(mismatch.highPE, null);
  assert.equal(mismatch.highYield, null);
  assert.equal(valuationRows([row(2025, { dividendPerShare: 0 })], true, 1)[0].payout, 0);
});

test('current P/E uses the source trailing P/E and EPS when available', () => {
  const annual = [row(2025)];
  const study = { annual, prices: [{ date: '2026-10-23', close: 30 }], financialCurrency: 'USD', priceCurrency: 'USD', overview: { HighPriceTtm: 36, LowPriceTtm: 24, Dividend: 0 } };
  const live = { currency: 'USD', regular: { price: 33 }, trailingEPS: 3, trailingPE: 11 };
  const value = currentValuation(study, annual, live);
  assert.equal(value.eps, 3);
  assert.equal(value.highPE, 12);
  assert.equal(value.lowPE, 8);
  assert.equal(value.currentPE, 11);
  assert.equal(value.peSource, 'Yahoo Finance trailing P/E');
});

test('without a live quote, current valuation uses the newest calculated TTM rather than stale annual EPS', () => {
  const annual = [row(2025)];
  const quarterly = [[2025, 1, '2025-03-31', 0.4], [2025, 2, '2025-06-30', 0.4], [2026, 1, '2026-03-31', 0.5], [2026, 2, '2026-06-30', 0.6]].map(([fiscalYear, quarter, periodEnd, eps]) => ({ ...row(fiscalYear), quarter, periodEnd, eps, epsSplitFactor: 1 }));
  const study = { annual, quarterly, prices: [{ date: '2026-10-23', close: 46 }], financialCurrency: 'USD', priceCurrency: 'USD', epsAdjustment: { status: 'normalized' } };
  const value = currentValuation(study, annual, null);
  assert.ok(Math.abs(value.eps - 2.3) < 1e-12);
  assert.ok(Math.abs(value.currentPE - 20) < 1e-12);
});
