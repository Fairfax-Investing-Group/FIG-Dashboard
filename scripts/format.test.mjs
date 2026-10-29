import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/lib/format.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { numberFormatter, dateFormatter, formatNumber, calendarDate, marketDate } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('shared formatters preserve decimal, currency, compact, and date output', () => {
  for (const currency of ['USD', 'JPY', 'EUR']) {
    for (const options of [
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
      { style: 'currency', currency, currencyDisplay: 'narrowSymbol' },
      { notation: 'compact', maximumFractionDigits: 1 },
    ]) {
      for (const value of [0, -0, -1234.567, 1e9]) {
        assert.equal(numberFormatter(options).format(value), new Intl.NumberFormat('en-US', options).format(value));
      }
      assert.equal(numberFormatter(options), numberFormatter(options), 'Repeated calls reuse the same formatter');
    }
  }
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(1234.567, 1), '1,234.6');
  const date = '2026-03-08';
  assert.equal(calendarDate(date), new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
  const stamp = `${date}T16:30:00Z`;
  assert.equal(marketDate(stamp), new Date(stamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }));
  assert.equal(calendarDate('unavailable'), 'Invalid Date');
  assert.equal(marketDate('unavailable'), 'Invalid Date');
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  assert.equal(dateFormatter(options), dateFormatter(options));
  assert.equal(dateFormatter(options).format(new Date(stamp)), new Date(stamp).toLocaleDateString(undefined, options));
});
