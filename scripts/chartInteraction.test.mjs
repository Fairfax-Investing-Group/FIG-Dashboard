import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/chartInteraction.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { nearestObservation, nearestChartLine, interpolatedObservation, stackChartLabels } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const observations = [{ timestamp: 0, value: 100 }, { timestamp: 100, value: 400 }];

test('individual actual-line inspection reports an actual observation and its original date', () => {
  assert.deepEqual(nearestObservation(observations, 40), observations[0]);
  assert.deepEqual(nearestObservation(observations, 60), observations[1]);
  assert.deepEqual(nearestObservation(observations, 200), observations[1]);
  assert.equal(nearestObservation([], 40), null);
  assert.equal(nearestObservation(observations, NaN), null);
});

test('hover chooses the closest rendered line rather than a manually selected series', () => {
  const lines = [
    { id: 'sales:actual', points: [{ x: 0, y: 10 }, { x: 100, y: 30 }] },
    { id: 'eps:fit', points: [{ x: 0, y: 50 }, { x: 100, y: 70 }] },
  ];
  assert.equal(nearestChartLine(lines, { x: 50, y: 22 }), 'sales:actual');
  assert.equal(nearestChartLine(lines, { x: 50, y: 58 }), 'eps:fit');
  assert.equal(nearestChartLine(lines, { x: 50, y: 150 }), null);
});

test('hover respects missing-data gaps and hidden lines', () => {
  const gapped = [{ id: 'sales:actual', points: [{ x: 0, y: 10 }, null, { x: 100, y: 10 }] }];
  assert.equal(nearestChartLine(gapped, { x: 50, y: 10 }), null);
  assert.equal(nearestChartLine(gapped, { x: 1, y: 10 }), 'sales:actual');
  assert.equal(nearestChartLine([], { x: 1, y: 10 }), null);
});

test('yearly tooltip snaps to an observation, not an interpolated amount', () => {
  const year = 365 * 86400000;
  const yearly = [{ timestamp: 0, value: 100 }, { timestamp: year, value: 400 }];
  assert.deepEqual(nearestObservation(yearly, year * 0.4), yearly[0]);
  assert.deepEqual(nearestObservation(yearly, year * 0.6), yearly[1]);
});


test('regression hover follows the cursor continuously without snapping to yearly endpoints', () => {
  const plotted = [{ timestamp: 0, value: 1 }, { timestamp: 100, value: 3 }];
  assert.deepEqual(interpolatedObservation(plotted, 40), { timestamp: 40, value: 1.8 });
  assert.ok(Math.abs(interpolatedObservation(observations, 50, 'log').value - 200) < 1e-10);
  assert.equal(interpolatedObservation(observations, 50, 'log').timestamp, 50);
  assert.equal(interpolatedObservation(observations, -1, 'log'), null);
  assert.equal(interpolatedObservation(observations, 101, 'log'), null);
});


test('actual data wins hover priority even when regression is closer', () => {
  const lines = [
    { id: 'sales:fit', priority: 0, points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] },
    { id: 'sales:actual', priority: 1, points: [{ x: 0, y: 24 }, { x: 100, y: 24 }] },
  ];
  assert.equal(nearestChartLine(lines, { x: 50, y: 10 }), 'sales:actual');
  assert.equal(nearestChartLine([...lines].reverse(), { x: 50, y: 10 }), 'sales:actual');
  assert.equal(nearestChartLine(lines, { x: 50, y: 0 }), 'sales:fit');
});

test('the nearest actual line wins among multiple actual series', () => {
  const lines = [
    { id: 'sales:actual', priority: 1, points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] },
    { id: 'eps:actual', priority: 1, points: [{ x: 0, y: 20 }, { x: 100, y: 20 }] },
    { id: 'eps:fit', priority: 0, points: [{ x: 0, y: 18 }, { x: 100, y: 18 }] },
  ];
  assert.equal(nearestChartLine(lines, { x: 50, y: 18 }), 'eps:actual');
});


test('moving labels snap around an existing label without moving its anchor', () => {
  assert.deepEqual(stackChartLabels([{ id: 'sales', y: 100 }, { id: 'eps', y: 103 }], 0, 200, 18, 'eps'), [{ id: 'sales', y: 100 }, { id: 'eps', y: 118 }]);
  assert.deepEqual(stackChartLabels([{ id: 'sales', y: 100 }, { id: 'eps', y: 97 }], 0, 200, 18, 'eps'), [{ id: 'sales', y: 100 }, { id: 'eps', y: 82 }]);
});

test('coincident labels remain distinct and stay inside the chart', () => {
  for (const y of [8, 100, 192]) {
    const positions = stackChartLabels(['sales', 'eps', 'ptp', 'price'].map(id => ({ id, y })), 8, 192);
    assert.equal(positions.length, 4);
    for (const [index, label] of positions.entries()) {
      assert.ok(label.y >= 8 && label.y <= 192);
      for (const other of positions.slice(index + 1)) assert.ok(Math.abs(label.y - other.y) >= 18);
    }
  }
});
