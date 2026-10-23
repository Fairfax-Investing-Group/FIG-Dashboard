import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/financialMath.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { annualGrowth, fiveYearEstimate } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
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
