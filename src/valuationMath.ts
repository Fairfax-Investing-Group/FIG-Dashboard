import type { AnnualRow, MarketQuote, Study } from './types';
import { trailingFinancials } from './trailingFinancials';
import { FIRST_HISTORY_YEAR, reportingYear, reportingYearOffset } from './reportingYears';

export type ValuationRow = {
  year: number; periodEnd: string | null;
  high: number | null; low: number | null; eps: number | null;
  highPE: number | null; lowPE: number | null;
  dividend: number | null; payout: number | null; highYield: number | null;
};
export const finiteValue = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;
const positive = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0;
export const peRatio = (price: number | null | undefined, eps: number | null | undefined): number | null => positive(price) && positive(eps) ? price! / eps! : null;
const percent = (numerator: number | null, denominator: number | null) => numerator !== null && positive(denominator) ? numerator / denominator! * 100 : null;

export function valuationRows(annual: AnnualRow[], compatibleCurrencies: boolean, years: number): ValuationRow[] {
  if (!annual.length) return [];
  const offset = reportingYearOffset(annual);
  const yearOf = (row: AnnualRow) => reportingYear(row, offset);
  const last = Math.max(...annual.map(yearOf));
  const first = Math.max(FIRST_HISTORY_YEAR, last - years + 1);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const year = first + index;
    const row = annual.find(row => yearOf(row) === year);
    const high = finiteValue(row?.highPrice), low = finiteValue(row?.lowPrice), eps = finiteValue(row?.eps), dividend = finiteValue(row?.dividendPerShare);
    return { year, periodEnd: row?.periodEnd ?? null, high, low, eps, dividend,
      highPE: compatibleCurrencies && positive(eps) ? finiteValue(row?.highPE) ?? peRatio(high, eps) : null,
      lowPE: compatibleCurrencies && positive(eps) ? finiteValue(row?.lowPE) ?? peRatio(low, eps) : null,
      payout: percent(dividend, eps), highYield: compatibleCurrencies ? percent(dividend, low) : null,
    };
  });
}

export function valuationAverage(rows: ValuationRow[], years: number): Omit<ValuationRow, 'year' | 'periodEnd'> {
  const last = rows.at(-1)?.year ?? 0;
  const selected = rows.filter(row => row.year > last - years);
  const mean = (key: keyof Omit<ValuationRow, 'year' | 'periodEnd'>) => {
    const values = selected.map(row => row[key]).filter((value): value is number => value !== null && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return { high: mean('high'), low: mean('low'), eps: mean('eps'), highPE: mean('highPE'), lowPE: mean('lowPE'), dividend: mean('dividend'), payout: mean('payout'), highYield: mean('highYield') };
}

export function currentValuation(study: Study, annual: AnnualRow[], quote: MarketQuote | null) {
  const compatible = Boolean(study.priceCurrency && study.priceCurrency === study.financialCurrency);
  const live = quote?.currency === study.priceCurrency ? quote : null;
  const normalizedQuarters = (study.quarterly ?? []).map(row => ({ ...row,
    eps: study.epsAdjustment?.status === 'normalized' && row.epsSplitFactor != null && row.epsSplitFactor > 0 ? row.eps : null,
  }));
  const lastAnnual = [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  const trailing = trailingFinancials(annual, normalizedQuarters).filter(row => lastAnnual && row.periodEnd > lastAnnual.periodEnd).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  const eps = compatible && live?.trailingEPS != null ? finiteValue(live.trailingEPS) : trailing ? finiteValue(trailing.eps) : finiteValue(lastAnnual?.eps);
  const dividend = finiteValue(trailing ? trailing.dividendPerShare : lastAnnual?.dividendPerShare) ?? finiteValue(study.overview?.Dividend);
  const high = finiteValue(study.overview?.HighPriceTtm), low = finiteValue(study.overview?.LowPriceTtm);
  const price = finiteValue(live?.regular?.price) ?? finiteValue(study.prices.at(-1)?.close);
  const currentPE = positive(live?.trailingPE) ? live!.trailingPE! : compatible ? peRatio(price, eps) : null;
  return { high, low, eps, dividend, highPE: compatible ? peRatio(high, eps) : null, lowPE: compatible ? peRatio(low, eps) : null,
    payout: percent(dividend, eps), highYield: compatible ? percent(dividend, low) : null,
    price, currentPE, epsSource: compatible && live?.trailingEPS != null ? 'Yahoo Finance EPS (TTM)' : trailing ? `Calculated TTM through ${trailing.periodEnd}` : lastAnnual ? `Latest annual EPS (${lastAnnual.periodEnd})` : 'EPS unavailable',
    peSource: positive(live?.trailingPE) ? 'Yahoo Finance trailing P/E' : 'Regular-session price / EPS',
  };
}
