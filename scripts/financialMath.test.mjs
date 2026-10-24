import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/financialMath.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { annualGrowth, fiveYearEstimate, fiveYearAverage, logLinearRegression } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const points = values => values.map((value, index) => ({ periodEnd: `${2016 + index}-12-31`, value }));

test('log-linear regression matches all three reference growth percentages', () => {
  const examples = [
    [[90272, 110855, 136819, 161857, 182527, 257637, 282836, 307394, 350018, 402836], '18.2'],
    [[1.39, 0.90, 2.19, 2.46, 2.93, 5.61, 4.56, 5.80, 8.04, 10.81], '28.3'],
    [[24150, 27193, 34913, 39625, 48082, 90734, 71328, 85717, 119815, 158826], '23.0'],
  ];
  for (const [values, expected] of examples) assert.equal(annualGrowth(points(values)).toFixed(1), expected);
});

test('missing observations retain actual fiscal year spacing', () => {
  const observations = points([100, null, 121]);
  assert.ok(Math.abs(annualGrowth(observations) - 10) < 1e-10);
  assert.ok(Math.abs(annualGrowth([...observations].reverse()) - 10) < 1e-10);
});

test('nonpositive, nonfinite, or insufficient observations cannot produce log growth', () => {
  for (const values of [[], [100], [null, 100], [100, 0, 121], [100, -1, 121], [100, Infinity]]) {
    assert.equal(annualGrowth(points(values)), null);
  }
  assert.equal(annualGrowth([{ periodEnd: '2025-12-31', value: 100 }, { periodEnd: '2025-12-31', value: 110 }]), null);
});

test('flat and declining histories return zero and negative growth', () => {
  assert.equal(annualGrowth(points([100, 100, 100])), 0);
  assert.ok(Math.abs(annualGrowth(points([100, 90, 81])) + 10) < 1e-10);
});

test('forecasts continue to compound the user rate independently of historical growth', () => {
  assert.ok(Math.abs(fiveYearEstimate(100, '20') - 248.832) < 1e-10);
  assert.equal(fiveYearEstimate(10.81, '0'), 10.81);
  assert.equal(fiveYearEstimate(10.81, ''), null);
  assert.equal(fiveYearEstimate(null, '15'), null);
  assert.equal(fiveYearEstimate(10.81, '-101'), null);
});


test('fitted log-linear values recover an exact exponential trend', () => {
  const input = points([100, 110, 121]);
  const model = logLinearRegression(input);
  assert.ok(Math.abs(model.growthRate - 10) < 1e-10);
  model.fitted.forEach((point, index) => assert.ok(Math.abs(point.value - input[index].value) < 1e-10));
  assert.deepEqual(input.map(point => point.value), [100, 110, 121]);
});

test('regression fit uses all observations and preserves missing-year gaps', () => {
  const model = logLinearRegression(points([100, 200, 100]));
  const expected = Math.cbrt(100 * 200 * 100);
  assert.ok(model.fitted.every(point => Math.abs(point.value - expected) < 1e-10));
  const gapped = logLinearRegression(points([100, null, 121]));
  assert.equal(gapped.fitted.length, 2);
  assert.equal(gapped.fitted[1].periodEnd, '2018-12-31');
  assert.equal(logLinearRegression(points([100, 0, 121])), null);
});


test('five-year averages use the latest five years without substituting earlier missing values', () => {
  assert.equal(fiveYearAverage([999, 10, 20, 30, 40, 50]), 30);
  assert.equal(fiveYearAverage([999, 0, null, 20, undefined, 40]), 20);
  assert.equal(fiveYearAverage([999, null, null, null, null, null]), null);
  assert.equal(fiveYearAverage([]), null);
  assert.equal(fiveYearAverage([NaN, Infinity]), null);
});

test('excluding an outlier year recalculates growth without compressing elapsed years', () => {
  const input = points([100, 500, 121, 133.1]);
  assert.ok(Math.abs(annualGrowth(input) - 10) > 1);
  assert.ok(Math.abs(annualGrowth(input, [2017]) - 10) < 1e-10);
  const fit = logLinearRegression(input, [2017]);
  assert.deepEqual(fit.fitted.map(point => point.periodEnd), ['2016-12-31', '2018-12-31', '2019-12-31']);
  assert.equal(input[1].value, 500);
  assert.equal(annualGrowth(input, []), annualGrowth(input));
});

test('excluded losses and endpoint years do not contribute to growth', () => {
  const input = points([100, -5, 121, 133.1]);
  assert.equal(annualGrowth(input), null);
  assert.ok(Math.abs(annualGrowth(input, [2017]) - 10) < 1e-10);
  assert.ok(Math.abs(annualGrowth(input, [2016, 2017]) - 10) < 1e-10);
  assert.equal(annualGrowth(input, [2016, 2017, 2018]), null);
  assert.equal(logLinearRegression(input, [2016, 2017, 2018, 2019]), null);
});

test('a fit can span the full history while excluded endpoint years do not affect its slope', () => {
  const input = points([500, 110, 121, 900]);
  const dates = input.map(point => point.periodEnd);
  const model = logLinearRegression(input, [2016, 2019], dates);
  assert.ok(Math.abs(model.growthRate - 10) < 1e-10);
  assert.deepEqual(model.fitted.map(point => point.periodEnd), dates);
  assert.ok(Math.abs(model.fitted[0].value - 100) < 1e-10);
  assert.ok(Math.abs(model.fitted.at(-1).value - 133.1) < 1e-10);
});
