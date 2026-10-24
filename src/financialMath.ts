type GrowthPoint = { periodEnd: string; value: number | null };

export function logLinearRegression(points: GrowthPoint[], excludedYears: number[] = [], fitDates?: string[]): { growthRate: number; fitted: { periodEnd: string; value: number }[] } | null {
  const available = points.filter(point => point.value !== null && !excludedYears.includes(new Date(point.periodEnd).getUTCFullYear()));
  if (available.length < 2 || available.some(point => !Number.isFinite(point.value) || point.value! <= 0)) return null;
  // Fiscal year coordinates preserve missing-year gaps and match annual studies.
  const years = available.map(point => new Date(point.periodEnd).getUTCFullYear());
  if (years.some(year => !Number.isFinite(year))) return null;
  const logs = available.map(point => Math.log(point.value!));
  const meanYear = years.reduce((sum, year) => sum + year, 0) / years.length;
  const meanLog = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const variance = years.reduce((sum, year) => sum + (year - meanYear) ** 2, 0);
  if (variance === 0) return null;
  const covariance = years.reduce((sum, year, index) => sum + (year - meanYear) * (logs[index] - meanLog), 0);
  const result = Math.expm1(covariance / variance) * 100;
  if (!Number.isFinite(result)) return null;
  const slope = covariance / variance;
  const fitted = (fitDates ?? available.map(point => point.periodEnd)).map(periodEnd => ({ periodEnd, value: Math.exp(meanLog + slope * (new Date(periodEnd).getUTCFullYear() - meanYear)) })).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (fitted.some(point => !Number.isFinite(point.value) || point.value <= 0)) return null;
  return { growthRate: result, fitted };
}

export function annualGrowth(points: GrowthPoint[], excludedYears: number[] = []): number | null {
  return logLinearRegression(points, excludedYears)?.growthRate ?? null;
}

export function fiveYearEstimate(latest: number | null, forecast: string): number | null {
  if (latest === null || !forecast.trim()) return null;
  const rate = Number(forecast);
  if (!Number.isFinite(rate) || rate < -100) return null;
  const result = latest * Math.pow(1 + rate / 100, 5);
  return Number.isFinite(result) ? result : null;
}

/** Average only available observations within the latest five displayed fiscal years. */
export function fiveYearAverage(values: (number | null | undefined)[]): number | null {
  const available = values.slice(-5).filter((value): value is number => value != null && Number.isFinite(value));
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}
