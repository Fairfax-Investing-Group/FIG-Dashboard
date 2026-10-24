import type { Company } from './SearchPage';

export type Metric = 'sales' | 'eps' | 'pretaxProfit';
export type FactSource = { concept: string; filed: string; accession: string | null; unit: string; start: string; end: string };
export type AnnualRow = {
  fiscalYear?: number;
  periodEnd: string;
  sales: number | null;
  eps: number | null;
  epsReported?: number | null;
  epsSplitFactor?: number | null;
  pretaxProfit: number | null;
  bookValuePerShare?: number | null;
  freeCashFlowPerShare?: number | null;
  freeCashFlow?: number | null;
  dilutedShares?: number | null;
  shareDays?: number | null;
  highPrice?: number | null;
  lowPrice?: number | null;
  highPE?: number | null;
  lowPE?: number | null;
  dividendPerShare?: number | null;
  pretaxMargin?: number | null;
  returnOnEquity?: number | null;
  debtToCapital?: number | null;
  salesSource: FactSource | null;
  epsSource: FactSource | null;
  pretaxProfitSource: FactSource | null;
};
export type Source = { status: 'ok' | 'error'; url: string; retrievedAt: string | null; error: string | null };
export type MarketQuote = {
  currency: string | null;
  regular: { price: number; change: number | null; percent: number | null; time: string | null } | null;
  postMarket: { price: number; change: number; percent: number; time: string } | null;
  retrievedAt: string;
  trailingPE?: number | null;
  trailingEPS?: number | null;
};
export type CompanyOverview = {
  Description?: string | null; SectorDesc?: string | null; IndustryDesc?: string | null;
  HighPriceTtm?: number | null; LowPriceTtm?: number | null;
  MarketCap?: number | null; beta?: number | null;
  SharesOutstanding?: number | null; AverageVolume?: number | null;
  Dividend?: number | null;
  IndicatedDividend?: number | null;
};
export type Study = {
  id: string;
  company: Company;
  overview?: CompanyOverview;
  createdAt: string;
  financialCurrency: string | null;
  priceCurrency: string | null;
  annual: AnnualRow[];
  quarterly?: (AnnualRow & { fiscalYear: number; quarter: number; form?: string })[];
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
  Company: CompanyOverview & { Ticker: string; CompanyName: string; CentralIndexKey: string; ExchangeType: string };
  AnnualData: {
    FiscalYear: number; AsOfDataDate: string;
    Sales: number | null; EPS: number | null; PTP: number | null;
    BookValue?: number | null; CashFlow?: number | null;
    FreeCashFlow?: number | null; SharesOut?: number | null;
    HighPrice?: number | null; LowPrice?: number | null;
    HighPE?: number | null; LowPE?: number | null; Dividend?: number | null;
    PtpOnSales: number | null; ROE?: number | null; DTC?: number | null; EPSSplitFactor: number | null;
    Sources: Record<'Sales' | 'EPS' | 'PTP', {
      Concept: string; Filed: string; Accession: string | null;
      Unit: string; Start: string; End: string;
    } | null> & { SharesOut?: { Start: string | null; End: string | null } | null };
  }[];
  QuarterlyData?: (StudyDocument['AnnualData'][number] & { QuarterNo: number; Form?: string })[];
  DailyPrices: { Date: string; Close: number }[];
  MonthlyPrices: { Month: string; Date: string; Close: number }[];
  ComputedValues: { GrowthMethod: 'log-linear-regression'; SalesGrowthRate: number | null; EPSGrowthRate: number | null; PTPGrowthRate: number | null };
  Metadata: {
    DataStage?: 'fundamentals' | 'complete';
    FinancialCurrency: string | null; PriceCurrency: string | null;
    Sources: Record<'SEC' | 'YahooFinance', { Status: 'ok' | 'error'; URL: string; RetrievedAt: string | null; Error: string | null }>;
    Warnings: string[];
    EPSAdjustment: { Status: 'normalized' | 'unavailable'; AsOf: string | null; Method: string | null; HistoryStart: string | null; Events: { Date: string; Ratio: number }[] };
  };
};
