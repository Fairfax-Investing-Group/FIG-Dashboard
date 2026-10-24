import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/reportingYears.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { reportingYear, reportingYearOffset } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('a January fiscal close is displayed under the previous calendar year without altering source dates', () => {
  const annual = [{ fiscalYear: 2026, periodEnd: '2026-01-31' }];
  const offset = reportingYearOffset(annual);
  assert.equal(offset, -1);
  assert.equal(reportingYear(annual[0], offset), 2025);
  assert.equal(reportingYear({ fiscalYear: 2027, periodEnd: '2026-04-30' }, offset), 2026);
  assert.deepEqual(annual[0], { fiscalYear: 2026, periodEnd: '2026-01-31' });
});

test('completed September and December fiscal years keep their accurate calendar labels', () => {
  for (const end of ['2025-09-27', '2025-12-31']) {
    const annual = [{ fiscalYear: 2025, periodEnd: end }];
    assert.equal(reportingYearOffset(annual), 0);
    assert.equal(reportingYear(annual[0], 0), 2025);
  }
});
