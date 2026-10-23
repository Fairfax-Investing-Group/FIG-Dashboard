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
  epsAdjustment?: { status: 'normalized' | 'unavailable'; asOf?: string; method?: string; events?: { date: string; ratio: number }[]; historyStart?: string };
};
