import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/portfolioMath.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { portfolioSharpe, portfolioDayChange, portfolioRiskMetrics } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('daily portfolio return uses prior-close weights and includes unchanged cash', () => {
  const holdings = [{ marketValue: 110, dayChange: .1 }, { marketValue: 180, dayChange: -.1 }];
  assert.ok(Math.abs(portfolioDayChange(holdings, 100) - (-.025)) < 1e-12);
  assert.equal(portfolioDayChange([{ marketValue: 100, dayChange: 0 }], 0), 0);
  assert.equal(portfolioDayChange([], 100), null);
  assert.equal(portfolioDayChange([{ marketValue: 100, dayChange: -1 }], 0), null);
});

test('risk metrics use daily downside, sample volatility, matched benchmark returns and peak-to-trough drawdown', () => {
  let value = 1;
  const history = [{ date: '2026-01-01', club: 0, benchmark: 0 }];
  for (let index = 1; index <= 60; index++) {
    value *= 1 + (index % 2 ? .02 : -.01);
    history.push({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), club: value - 1, benchmark: 0 });
  }
  const risk = portfolioRiskMetrics(history);
  assert.ok(Math.abs(risk.sortino - .005 / Math.sqrt(.5 * .01 ** 2) * Math.sqrt(252)) < 1e-10);
  assert.ok(Math.abs(risk.volatility - Math.sqrt(60 * .015 ** 2 / 59) * Math.sqrt(252)) < 1e-10);
  assert.ok(Math.abs(risk.maxDrawdown - .01) < 1e-10);
  assert.ok(Math.abs(risk.informationRatio - portfolioSharpe(history)) < 1e-10);
  assert.equal(portfolioRiskMetrics(history.map(point => ({ ...point, benchmark: point.club }))).informationRatio, null);
  const flat = portfolioRiskMetrics(history.map(point => ({ ...point, club: 0 })));
  assert.equal(flat.volatility, 0);
  assert.equal(flat.maxDrawdown, 0);
  assert.equal(flat.sortino, null);
  const short = portfolioRiskMetrics([{ date: '2026-01-01', club: .2, benchmark: 0 }, { date: '2026-01-02', club: -.1, benchmark: 0 }]);
  assert.ok(Math.abs(short.maxDrawdown - .25) < 1e-10);
  assert.equal(short.volatility, null);
  assert.equal(portfolioRiskMetrics([...history, history[0]]).maxDrawdown, null);
});

test('Sharpe converts cumulative returns to daily returns and annualizes sample volatility', () => {
  let value = 1;
  const history = [{ date: '2026-01-01', club: 0 }];
  for (let index = 1; index <= 60; index++) {
    value *= 1 + (index % 2 ? .02 : -.01);
    history.push({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), club: value - 1 });
  }
  const expected = .005 / Math.sqrt(60 * .015 ** 2 / 59) * Math.sqrt(252);
  assert.ok(Math.abs(portfolioSharpe(history) - expected) < 1e-10);
  assert.ok(portfolioSharpe(history, .04) < portfolioSharpe(history));
  assert.equal(portfolioSharpe(history.slice(0, 60)), null);
  assert.equal(portfolioSharpe(history.map(point => ({ ...point, club: 0 }))), null);
  assert.equal(portfolioSharpe([...history, history[0]]), null);
});
