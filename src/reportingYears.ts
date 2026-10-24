import type { AnnualRow } from './types';

/** Early-year fiscal closes (for example January 2026) primarily cover
 * the previous calendar year. Keep source fiscal years and dates unchanged.
 */
export function reportingYearOffset(annual: AnnualRow[]): number {
  const latest = [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  if (!latest) return 0;
  const month = Number(latest.periodEnd.slice(5, 7));
  return month >= 1 && month <= 3 ? -1 : 0;
}

export function reportingYear(row: Pick<AnnualRow, 'fiscalYear' | 'periodEnd'>, offset: number): number {
  return (row.fiscalYear ?? Number(row.periodEnd.slice(0, 4))) + offset;
}
