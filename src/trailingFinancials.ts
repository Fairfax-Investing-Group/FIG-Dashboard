import type { AnnualRow, Study } from './types';

type Quarter = NonNullable<Study['quarterly']>[number];
const year = (row: AnnualRow) => row.fiscalYear ?? Number(row.periodEnd.slice(0, 4));
const valid = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

/** One split-verification path for both chart and current valuation inputs. */
export function studyTrailingFinancials(study: Pick<Study, 'quarterly' | 'epsAdjustment'>, annual: AnnualRow[]): Quarter[] {
  return trailingFinancials(annual, (study.quarterly ?? []).map(row => ({ ...row,
    eps: study.epsAdjustment?.status === 'normalized' && row.epsSplitFactor != null && row.epsSplitFactor > 0 ? row.eps : null,
  })));
}

/** Roll the last annual filing forward using current YTD less prior-year YTD.
 * Raw quarter observations remain unchanged. Missing inputs never become zero.
 */
export function trailingFinancials(annual: AnnualRow[], quarters: Quarter[]): Quarter[] {
  const byPeriod = new Map(quarters.map(row => [`${row.fiscalYear}:${row.quarter}`, row]));
  return quarters.map(quarter => {
    const base = annual.find(row => year(row) === quarter.fiscalYear - 1);
    const current = Array.from({ length: quarter.quarter }, (_, index) => byPeriod.get(`${quarter.fiscalYear}:${index + 1}`));
    const previous = Array.from({ length: quarter.quarter }, (_, index) => byPeriod.get(`${quarter.fiscalYear - 1}:${index + 1}`));
    const lastFour = Array.from({ length: 4 }, (_, offset) => {
      const ordinal = quarter.fiscalYear * 4 + quarter.quarter - 1 - offset;
      return byPeriod.get(`${Math.floor(ordinal / 4)}:${ordinal % 4 + 1}`);
    });
    const roll = (read: (row: AnnualRow) => number | null | undefined): number | null => {
      if (base && current.every(row => row) && previous.every(row => row)) {
        const annualValue = read(base), now = current.map(row => read(row!)), ago = previous.map(row => read(row!));
        if (valid(annualValue) && now.every(valid) && ago.every(valid)) {
          const value = annualValue + now.reduce((sum, value) => sum + value, 0) - ago.reduce((sum, value) => sum + value, 0);
          return Number.isFinite(value) ? value : null;
        }
      }
      // The prior YTD may be missing even when the latest four quarters exist.
      if (!lastFour.every(row => row)) return null;
      const values = lastFour.map(row => read(row!));
      if (!values.every(valid)) return null;
      const total = values.reduce((sum, value) => sum + value, 0);
      return Number.isFinite(total) ? total : null;
    };
    const freeCashFlow = roll(row => row.freeCashFlow);
    const shareDays = roll(row => row.shareDays);
    const weightedShares = roll(row => valid(row.dilutedShares) && row.dilutedShares > 0 && valid(row.shareDays) ? row.dilutedShares * row.shareDays : null);
    const shares = valid(weightedShares) && valid(shareDays) && shareDays > 0 ? weightedShares / shareDays : null;
    return {
      ...quarter,
      sales: roll(row => row.sales), eps: roll(row => row.eps), pretaxProfit: roll(row => row.pretaxProfit),
      dividendPerShare: roll(row => row.dividendPerShare),
      freeCashFlow, dilutedShares: shares, shareDays,
      freeCashFlowPerShare: valid(freeCashFlow) && valid(shares) && shares > 0 ? freeCashFlow / shares : null,
      // Book value is a balance at quarter-end and is never accumulated.
      bookValuePerShare: quarter.bookValuePerShare ?? null,
    };
  });
}
