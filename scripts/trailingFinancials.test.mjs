import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/trailingFinancials.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { trailingFinancials } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const base = { fiscalYear: 2025, periodEnd: '2025-09-27', sales: 416161e6, eps: 7.46, pretaxProfit: 132729e6,
  freeCashFlow: 98767e6, dilutedShares: 15004.697e6, shareDays: 364 };
const quarters = [
  [2025, 1, '2024-12-28', 124300, 2.4, 42584, 26995, 15150.865],
  [2025, 2, '2025-03-29', 95359, 1.65, 29310, 20881, 15056.133],
  [2025, 3, '2025-06-28', 94036, 1.57, 28031, 24405, 14948.179],
  [2026, 1, '2025-12-27', 143756, 2.84, 51002, 51552, 14810.356],
  [2026, 2, '2026-03-28', 111184, 2.01, 35833, 26731, 14725.873],
  [2026, 3, '2026-06-27', 109417, 2.02, 36267, 31914, 14714.676],
].map(([fiscalYear, quarter, periodEnd, sales, eps, pretaxProfit, freeCashFlow, dilutedShares]) => ({
  fiscalYear, quarter, periodEnd, sales: sales * 1e6, eps, pretaxProfit: pretaxProfit * 1e6,
  freeCashFlow: freeCashFlow * 1e6, dilutedShares: dilutedShares * 1e6, shareDays: 91,
  bookValuePerShare: 7.36,
}));

test('AAPL FY2026 interim sales dots are TTM, including 466823 million at Q3', () => {
  const result = trailingFinancials([base], quarters).filter(row => row.fiscalYear === 2026);
  assert.deepEqual(result.map(row => row.sales / 1e6), [435617, 451442, 466823]);
  assert.equal(result[2].eps.toFixed(2), '8.71');
  assert.equal(result[2].pretaxProfit / 1e6, 155906);
  assert.equal(result[2].bookValuePerShare, 7.36);
  assert.equal(quarters.at(-1).sales, 109417e6, 'Raw quarterly data is preserved');
});

test('TTM free cash flow per share uses cash-flow totals and time-weighted shares', () => {
  const result = trailingFinancials([base], quarters).at(-1);
  assert.equal(result.freeCashFlow, 136683e6);
  const expectedShares = (base.dilutedShares * 364 + quarters.slice(3).reduce((sum, row) => sum + row.dilutedShares * 91, 0) - quarters.slice(0, 3).reduce((sum, row) => sum + row.dilutedShares * 91, 0)) / 364;
  assert.equal(result.dilutedShares, expectedShares);
  assert.equal(result.freeCashFlowPerShare, 136683e6 / expectedShares);
});

test('missing periods or facts stay unavailable; book value remains a quarter-end balance', () => {
  const missingQuarter = trailingFinancials([base], quarters.filter(row => !(row.fiscalYear === 2025 && row.quarter === 2))).at(-1);
  assert.equal(missingQuarter.sales, null);
  assert.equal(missingQuarter.bookValuePerShare, 7.36);
  const missingShares = trailingFinancials([{ ...base, dilutedShares: null }], quarters).at(-1);
  assert.equal(missingShares.sales, 466823e6);
  assert.equal(missingShares.freeCashFlowPerShare, null);
  const missingEPS = trailingFinancials([base], quarters.map((row, index) => index === 1 ? { ...row, eps: null } : row)).at(-1);
  assert.equal(missingEPS.eps, null);
  assert.equal(missingEPS.sales, 466823e6);
});

test('four consecutive reported quarters restore TTM when prior YTD is unavailable', () => {
  const rows = [[2026, 3, 20], [2026, 4, 25], [2027, 1, 30], [2027, 2, 35]].map(([fiscalYear, quarter, sales]) => ({ fiscalYear, quarter,
    periodEnd: '2026-07-31', sales, eps: sales / 100, pretaxProfit: sales / 10, freeCashFlow: sales / 5, dilutedShares: 10, shareDays: 91, bookValuePerShare: 5 }));
  const latest = trailingFinancials([], rows).at(-1);
  assert.equal(latest.sales, 110);
  assert.ok(Math.abs(latest.eps - 1.1) < 1e-12);
  assert.equal(latest.freeCashFlowPerShare, 2.2);
  assert.equal(latest.bookValuePerShare, 5);
  assert.equal(trailingFinancials([], rows.filter(row => row.quarter !== 4)).at(-1).sales, null);
});
