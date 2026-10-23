import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/chartInteraction.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { nearestObservation, fittedObservation } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const observations = [{ timestamp: 0, value: 100 }, { timestamp: 100, value: 400 }];

test('individual actual-line inspection reports an actual observation and its original date', () => {
  assert.deepEqual(nearestObservation(observations, 40), observations[0]);
  assert.deepEqual(nearestObservation(observations, 60), observations[1]);
  assert.deepEqual(nearestObservation(observations, 200), observations[1]);
  assert.equal(nearestObservation([], 40), null);
  assert.equal(nearestObservation(observations, NaN), null);
});

test('individual regression inspection interpolates in log space, without extrapolation', () => {
  const midpoint = fittedObservation(observations, 50);
  assert.ok(Math.abs(midpoint.value - 200) < 1e-10);
  assert.equal(midpoint.timestamp, 50);
  assert.deepEqual(fittedObservation(observations, 100), observations[1]);
  assert.equal(fittedObservation(observations, -1), null);
  assert.equal(fittedObservation(observations, 101), null);
  assert.equal(fittedObservation([], 0), null);
  assert.equal(fittedObservation(observations, NaN), null);
});
