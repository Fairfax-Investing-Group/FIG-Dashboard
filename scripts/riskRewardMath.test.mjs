import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/riskRewardMath.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { assumption, riskReward } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const inputs = { highPE: 20, lowPE: 10, highEPS: 5, lowEPS: 2, currentPrice: 40, annualDividend: 1, payoutPercent: 50,
  highYieldPercent: 5, averageLow: 30, recentLow: 15, manualLow: 12, lowMethod: 'pe', zoneSplit: '25-50-25', desiredRatio: 3, targetReturnPercent: 15 };

test('high and low P/E forecasts produce prices, zones and upside/downside from the stated assumptions', () => {
  const model = riskReward(inputs);
  assert.equal(model.highPrice, 100);
  assert.equal(model.lowPrice, 20);
  assert.equal(model.buyUpper, 40);
  assert.equal(model.sellLower, 80);
  assert.equal(model.zone, 'Buy');
  assert.equal(model.upsideDownside, 3);
  assert.equal(model.appreciation, 150);
  assert.equal(riskReward({ ...inputs, currentPrice: 60 }).zone, 'Hold');
  assert.equal(riskReward({ ...inputs, currentPrice: 85 }).zone, 'Sell');
});

test('every low-price option uses its own value and manual zero remains a real downside scenario', () => {
  for (const [lowMethod, expected] of [['pe', 20], ['recent', 15], ['average', 30], ['dividend', 20], ['manual', 12]]) {
    assert.equal(riskReward({ ...inputs, lowMethod }).lowPrice, expected);
  }
  assert.equal(riskReward({ ...inputs, lowMethod: 'manual', manualLow: 0 }).upsideDownside, 1.5);
  assert.equal(riskReward({ ...inputs, lowMethod: 'dividend', annualDividend: 0 }).lowPrice, null);
});

test('equal-thirds zoning changes the boundaries without changing the price forecasts', () => {
  const model = riskReward({ ...inputs, zoneSplit: 'thirds' });
  assert.equal(model.highPrice, 100);
  assert.ok(Math.abs(model.buyUpper - (20 + 80 / 3)) < 1e-12);
  assert.ok(Math.abs(model.sellLower - (100 - 80 / 3)) < 1e-12);
});

test('five-year returns separate price CAGR, payout-based yield and the additive annual estimate', () => {
  const model = riskReward(inputs);
  assert.equal(model.currentYield, 2.5);
  assert.equal(model.highReturns.averageYield, 2.5);
  assert.equal(model.averagePE, 15);
  assert.equal(model.averagePrice, 75);
  assert.ok(Math.abs(model.highReturns.priceCAGR - ((100 / 40) ** 0.2 - 1) * 100) < 1e-12);
  assert.equal(model.highReturns.annualReturn, model.highReturns.priceCAGR + 2.5);
  assert.equal(model.averageReturns.annualReturn, model.averageReturns.priceCAGR + 50 / 15);
});

test('buy-price ceiling satisfies both the chosen downside ratio and annual-return target', () => {
  const model = riskReward(inputs);
  assert.equal(model.ratioBuyCap, 40);
  assert.equal(model.buyPrice, Math.min(model.ratioBuyCap, model.returnBuyCap));
  const atCeiling = riskReward({ ...inputs, currentPrice: model.buyPrice });
  assert.ok(atCeiling.upsideDownside >= 3 - 1e-12);
  assert.ok(atCeiling.highReturns.annualReturn >= 15 - 1e-12);
  const returnBound = riskReward({ ...inputs, targetReturnPercent: 40 });
  const atReturnBound = riskReward({ ...inputs, targetReturnPercent: 40, currentPrice: returnBound.buyPrice });
  assert.ok(atReturnBound.highReturns.annualReturn >= 40 - 1e-12);
});

test('missing forecasts, losses and invalid ranges stay unavailable rather than becoming zero or infinity', () => {
  assert.equal(assumption(''), null);
  assert.equal(assumption(' '), null);
  assert.equal(assumption('-1'), null);
  assert.equal(assumption('0'), 0);
  assert.equal(assumption('Infinity'), null);
  const missingEPS = riskReward({ ...inputs, highEPS: null });
  assert.equal(missingEPS.highPrice, null);
  assert.equal(missingEPS.zone, 'Awaiting inputs');
  const invalid = riskReward({ ...inputs, lowMethod: 'manual', manualLow: 110 });
  assert.equal(invalid.zone, 'Check forecasts');
  assert.equal(invalid.upsideDownside, null);
  assert.equal(invalid.buyPrice, null);
  assert.equal(riskReward({ ...inputs, currentPrice: 20 }).upsideDownside, null);
  assert.equal(riskReward({ ...inputs, payoutPercent: null }).highReturns.annualReturn, null);
  assert.equal(riskReward({ ...inputs, annualDividend: 0, payoutPercent: 0 }).currentYield, 0);
});
