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

test('book value and free cash flow per share keep per-share units and missing observations', () => {
  const input = document();
  Object.assign(input.AnnualData[0], { BookValue: 18.8197, CashFlow: 2.9746 });
  const row = studyView(input).annual[0];
  assert.equal(row.bookValuePerShare, 18.8197);
  assert.equal(row.freeCashFlowPerShare, 2.9746);
  Object.assign(input.AnnualData[0], { BookValue: 0, CashFlow: -1.25 });
  const losses = studyView(input).annual[0];
  assert.equal(losses.bookValuePerShare, 0);
  assert.equal(losses.freeCashFlowPerShare, -1.25);
  delete input.AnnualData[0].BookValue;
  input.AnnualData[0].CashFlow = null;
  const missing = studyView(input).annual[0];
  assert.equal(missing.bookValuePerShare, null);
  assert.equal(missing.freeCashFlowPerShare, null);
});

test('quarterly observations retain fiscal periods and convert totals without scaling per-share values', () => {
  const input = document();
  input.QuarterlyData = [{ ...input.AnnualData[0], FiscalYear: 2026, QuarterNo: 1, AsOfDataDate: '2025-09-30', Sales: 120, EPS: 0.75, PTP: 24, BookValue: 5.5, CashFlow: 0.8, FreeCashFlow: 8, SharesOut: 10,
    Sources: { ...input.AnnualData[0].Sources, SharesOut: { Start: '2025-07-01', End: '2025-09-30' } } }];
  const quarter = studyView(input).quarterly[0];
  assert.equal(quarter.fiscalYear, 2026);
  assert.equal(quarter.quarter, 1);
  assert.equal(quarter.sales, 120e6);
  assert.equal(quarter.pretaxProfit, 24e6);
  assert.equal(quarter.eps, 0.75);
  assert.equal(quarter.bookValuePerShare, 5.5);
  assert.equal(quarter.freeCashFlowPerShare, 0.8);
  assert.equal(quarter.freeCashFlow, 8e6);
  assert.equal(quarter.dilutedShares, 10e6);
  assert.equal(quarter.shareDays, 92);
  assert.deepEqual(studyView(document()).quarterly, []);
});

test('historical valuation prices, ratios and dividends keep their per-share units', () => {
  const input = document();
  Object.assign(input.AnnualData[0], { HighPrice: 100, LowPrice: 70, HighPE: 50, LowPE: 35, Dividend: 0.5 });
  const row = studyView(input).annual[0];
  assert.equal(row.highPrice, 100);
  assert.equal(row.lowPrice, 70);
  assert.equal(row.highPE, 50);
  assert.equal(row.lowPE, 35);
  assert.equal(row.dividendPerShare, 0.5);
});
