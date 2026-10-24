import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/studyDocument.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { studyView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function document() {
  return {
    SchemaVersion: 1,
    Study: { StudyID: 'test', DateCreated: '2026-10-23T12:00:00Z' },
    Company: { Ticker: 'TEST', CompanyName: 'Test Company', CentralIndexKey: '0000000123', ExchangeType: 'Nasdaq' },
    AnnualData: [{ FiscalYear: 2025, AsOfDataDate: '2025-06-30', Sales: 90272, EPS: 1.3925, PTP: 24150, EPSSplitFactor: 4, Sources: { Sales: null, EPS: { Concept: 'EPS', Filed: '2025-08-01', Accession: 'test', Unit: 'USD/shares', Start: '2024-07-01', End: '2025-06-30' }, PTP: null } }],
    DailyPrices: [{ Date: '2026-10-22', Close: 50 }],
    ComputedValues: { SalesGrowthRate: 0.182, EPSGrowthRate: 0.283, PTPGrowthRate: 0.23 },
    Metadata: {
      FinancialCurrency: 'USD', PriceCurrency: 'CAD', Warnings: [],
      Sources: { SEC: { Status: 'ok', URL: 'sec', RetrievedAt: null, Error: null }, YahooFinance: { Status: 'ok', URL: 'yahoo', RetrievedAt: null, Error: null } },
      EPSAdjustment: { Status: 'normalized', AsOf: '2026-10-23', Method: null, HistoryStart: null, Events: [{ Date: '2025-09-01', Ratio: 4 }] },
    },
  };
}

test('canonical amounts and rates convert exactly once into chart/table units', () => {
  const input = document();
  const view = studyView(input);
  assert.equal(view.annual[0].sales, 90_272_000_000);
  assert.equal(view.annual[0].pretaxProfit, 24_150_000_000);
  assert.equal(view.annual[0].eps, 1.3925);
  assert.equal(view.growthRates.sales.toFixed(1), '18.2');
  assert.equal(view.growthRates.eps.toFixed(1), '28.3');
  assert.equal(view.annual[0].epsSource.accession, 'test');
  assert.equal(view.company.cik, 123);
  assert.equal(view.priceCurrency, 'CAD');
  assert.deepEqual(view.prices, [{ date: '2026-10-22', close: 50 }]);
  assert.equal(input.AnnualData[0].Sales, 90272);
});

test('missing values and normalization status survive conversion', () => {
  const input = document();
  Object.assign(input.AnnualData[0], { EPS: null, Sales: null, PTP: null, EPSSplitFactor: null });
  Object.assign(input.ComputedValues, { SalesGrowthRate: null, EPSGrowthRate: null, PTPGrowthRate: null });
  input.Metadata.EPSAdjustment.Status = 'unavailable';
  const view = studyView(input);
  assert.equal(view.annual[0].eps, null);
  assert.equal(view.annual[0].sales, null);
  assert.equal(view.growthRates.eps, null);
  assert.equal(view.epsAdjustment.status, 'unavailable');
});

test('an unsupported contract version fails explicitly', () => {
  assert.throws(() => studyView({ ...document(), SchemaVersion: 2 }), /Unsupported study data version/);
});


test('management ratios convert decimal fractions once and preserve missing fields', () => {
  const input = document();
  Object.assign(input.AnnualData[0], { PtpOnSales: 0.268, ROE: 0.144, DTC: 0.028 });
  const row = studyView(input).annual[0];
  assert.equal(row.pretaxMargin.toFixed(1), '26.8');
  assert.equal(row.returnOnEquity.toFixed(1), '14.4');
  assert.equal(row.debtToCapital.toFixed(1), '2.8');
  delete input.AnnualData[0].PtpOnSales;
  delete input.AnnualData[0].ROE;
  input.AnnualData[0].DTC = null;
  const missing = studyView(input).annual[0];
  assert.equal(missing.pretaxMargin.toFixed(1), '26.8');
  assert.equal(missing.returnOnEquity, null);
  assert.equal(missing.debtToCapital, null);
});
