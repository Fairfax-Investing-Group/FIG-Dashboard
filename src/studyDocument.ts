import type { AnnualRow, FactSource, Source, Study, StudyDocument } from './types';

/** Adapt the canonical document to chart/table units in one place. */
export function studyView(document: StudyDocument): Study {
  if (document.SchemaVersion !== 1) throw new Error('Unsupported study data version. Restart the backend and refresh.');
  const source = (value: StudyDocument['AnnualData'][number]['Sources']['Sales']): FactSource | null => value ? {
    concept: value.Concept, filed: value.Filed, accession: value.Accession,
    unit: value.Unit, start: value.Start, end: value.End,
  } : null;
  const upstream = (value: StudyDocument['Metadata']['Sources']['SEC']): Source => ({
    status: value.Status, url: value.URL, retrievedAt: value.RetrievedAt, error: value.Error,
  });
  const adjustment = document.Metadata.EPSAdjustment;
  const amount = (value: number | null) => value === null ? null : value * 1_000_000;
  const rate = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? null : value * 100;
  const shareDays = (row: StudyDocument['AnnualData'][number]) => {
    const period = row.Sources.SharesOut;
    if (!period?.Start || !period.End) return null;
    const days = (Date.parse(period.End) - Date.parse(period.Start)) / 86_400_000 + 1;
    return Number.isFinite(days) && days > 0 ? days : null;
  };
  const financialRow = (row: StudyDocument['AnnualData'][number]): AnnualRow => ({
    fiscalYear: row.FiscalYear, periodEnd: row.AsOfDataDate, sales: amount(row.Sales), eps: row.EPS, pretaxProfit: amount(row.PTP),
    bookValuePerShare: row.BookValue ?? null, freeCashFlowPerShare: row.CashFlow ?? null,
    freeCashFlow: amount(row.FreeCashFlow ?? null), dilutedShares: amount(row.SharesOut ?? null), shareDays: shareDays(row),
    highPrice: row.HighPrice ?? null, lowPrice: row.LowPrice ?? null,
    highPE: row.HighPE ?? null, lowPE: row.LowPE ?? null, dividendPerShare: row.Dividend ?? null,
    epsSplitFactor: row.EPSSplitFactor,
    pretaxMargin: rate(row.PtpOnSales ?? (row.PTP !== null && row.Sales !== null && row.Sales !== 0 ? row.PTP / row.Sales : null)),
    returnOnEquity: rate(row.ROE), debtToCapital: rate(row.DTC),
    salesSource: source(row.Sources.Sales), epsSource: source(row.Sources.EPS), pretaxProfitSource: source(row.Sources.PTP),
  });
  return {
    id: document.Study.StudyID, createdAt: document.Study.DateCreated,
    company: { ticker: document.Company.Ticker, name: document.Company.CompanyName, cik: Number(document.Company.CentralIndexKey), exchange: document.Company.ExchangeType },
    overview: document.Company,
    financialCurrency: document.Metadata.FinancialCurrency, priceCurrency: document.Metadata.PriceCurrency,
    annual: document.AnnualData.map(financialRow),
    quarterly: (document.QuarterlyData ?? []).map(row => ({ ...financialRow(row), fiscalYear: row.FiscalYear, quarter: row.QuarterNo, form: row.Form })),
    prices: (document.Metadata.PriceInterval === '1wk' ? document.WeeklyPrices ?? [] : document.DailyPrices).map(point => ({ date: point.Date, close: point.Close })),
    priceInterval: document.Metadata.PriceInterval ?? '1d',
    sources: { sec: upstream(document.Metadata.Sources.SEC), yfinance: upstream(document.Metadata.Sources.YahooFinance) },
    warnings: document.Metadata.Warnings,
    growthRates: { sales: rate(document.ComputedValues.SalesGrowthRate), eps: rate(document.ComputedValues.EPSGrowthRate), pretaxProfit: rate(document.ComputedValues.PTPGrowthRate) },
    epsAdjustment: { status: adjustment.Status, asOf: adjustment.AsOf ?? undefined, method: adjustment.Method ?? undefined, historyStart: adjustment.HistoryStart ?? undefined, events: adjustment.Events.map(event => ({ date: event.Date, ratio: event.Ratio })) },
  };
}
