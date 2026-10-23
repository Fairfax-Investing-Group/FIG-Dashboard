import type { Company } from './SearchPage';

export type Metric = 'sales' | 'eps' | 'pretaxProfit';
export type FactSource = { concept: string; filed: string; accession: string | null; unit: string; start: string; end: string };
export type AnnualRow = {
  periodEnd: string;
  sales: number | null;
  eps: number | null;
  epsReported?: number | null;
  epsSplitFactor?: number | null;
  pretaxProfit: number | null;
  salesSource: FactSource | null;
  epsSource: FactSource | null;
  pretaxProfitSource: FactSource | null;
};
export type Source = { status: 'ok' | 'error'; url: string; retrievedAt: string | null; error: string | null };
export type Study = {
  id: string;
  company: Company;
  createdAt: string;
  financialCurrency: string | null;
  priceCurrency: string | null;
  annual: AnnualRow[];
  prices: { date: string; close: number }[];
  sources: { sec: Source; yfinance: Source };
  warnings: string[];
  growthRates?: Record<Metric, number | null>;
  epsAdjustment?: { status: 'normalized' | 'unavailable'; asOf?: string; method?: string; events?: { date: string; ratio: number }[]; historyStart?: string };
};


/** API/storage contract. Company totals use millions; rates are decimal fractions. */
export type StudyDocument = {
  SchemaVersion: 1;
  Study: { StudyID: string; Ticker: string; DateCreated: string };
  Company: { Ticker: string; CompanyName: string; CentralIndexKey: string; ExchangeType: string };
  AnnualData: {
    FiscalYear: number; AsOfDataDate: string;
    Sales: number | null; EPS: number | null; PTP: number | null;
    PtpOnSales: number | null; EPSSplitFactor: number | null;
    Sources: Record<'Sales' | 'EPS' | 'PTP', {
      Concept: string; Filed: string; Accession: string | null;
      Unit: string; Start: string; End: string;
    } | null>;
  }[];
  DailyPrices: { Date: string; Close: number }[];
  MonthlyPrices: { Month: string; Date: string; Close: number }[];
  ComputedValues: { GrowthMethod: 'log-linear-regression'; SalesGrowthRate: number | null; EPSGrowthRate: number | null; PTPGrowthRate: number | null };
  Metadata: {
    FinancialCurrency: string | null; PriceCurrency: string | null;
    Sources: Record<'SEC' | 'YahooFinance', { Status: 'ok' | 'error'; URL: string; RetrievedAt: string | null; Error: string | null }>;
    Warnings: string[];
    EPSAdjustment: { Status: 'normalized' | 'unavailable'; AsOf: string | null; Method: string | null; HistoryStart: string | null; Events: { Date: string; Ratio: number }[] };
  };
};
