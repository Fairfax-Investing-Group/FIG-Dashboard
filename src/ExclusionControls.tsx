import type { ReactNode } from 'react';

export type TableExclusions = {
  scope?: 'management';
  excludedYears: number[];
  excludedValues: string[];
  onToggleYear: (year: number) => void;
  onToggleValue: (metric: string, year: number) => void;
  onResetExclusions: () => void;
};
export const valueId = (metric: string, year: number) => `${metric}:${year}`;
export const isValueExcluded = (controls: Pick<TableExclusions, 'excludedYears' | 'excludedValues'>, metric: string, year: number) => controls.excludedYears.includes(year) || controls.excludedValues.includes(valueId(metric, year));
export const metricExcludedYears = (controls: Pick<TableExclusions, 'excludedYears' | 'excludedValues'>, metric: string) => [...new Set([...controls.excludedYears, ...controls.excludedValues.filter(id => id.startsWith(`${metric}:`)).map(id => Number(id.slice(metric.length + 1)))])];

export function ExclusionYear({ year, controls }: { year: number; controls: TableExclusions }) {
  const excluded = controls.excludedYears.includes(year);
  return <button type="button" className="table-year-toggle" aria-label={`${excluded ? 'Restore' : 'Exclude'} year ${year} in ${controls.scope === 'management' ? 'Evaluate Management' : 'company data and valuation'}`} aria-pressed={excluded} onClick={() => controls.onToggleYear(year)}>{excluded ? <del>{year}</del> : year}</button>;
}

export function ExclusionValue({ metric, year, name, available, children, controls }: { metric: string; year: number; name: string; available: boolean; children: ReactNode; controls: TableExclusions }) {
  const excluded = isValueExcluded(controls, metric, year);
  if (!available) return <span>{children}</span>;
  const wholeYear = controls.excludedYears.includes(year);
  return <button type="button" className={`table-value-toggle${excluded ? ' is-excluded' : ''}`} aria-label={`${excluded ? 'Restore' : 'Exclude'} ${name} for ${year}`} aria-pressed={excluded} disabled={wholeYear} title={wholeYear ? 'Restore the year using its heading first' : 'Click to cross out or restore this value'} onClick={() => controls.onToggleValue(metric, year)}>{excluded ? <del>{children}</del> : children}</button>;
}

export function ExclusionHelp({ controls }: { controls: TableExclusions }) {
  const hasExclusions = controls.excludedYears.length > 0 || controls.excludedValues.length > 0;
  return <div className="table-exclusion-help"><span>{controls.scope === 'management' ? 'Click a value or year to exclude it from Evaluate Management only.' : 'Click a value to cross it out. Click a year to exclude it from company data, valuation, and the chart.'}</span><button type="button" style={{ visibility: hasExclusions ? 'visible' : 'hidden' }} disabled={!hasExclusions} aria-hidden={!hasExclusions} onClick={controls.onResetExclusions}>Restore all exclusions</button></div>;
}
