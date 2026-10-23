type GrowthPoint = { periodEnd: string; value: number | null };

export function annualGrowth(points: GrowthPoint[]): number | null {
  const available = points.filter(point => point.value !== null);
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
  return Number.isFinite(result) ? result : null;
}

export function fiveYearEstimate(latest: number | null, forecast: string): number | null {
  if (latest === null || !forecast.trim()) return null;
  const rate = Number(forecast);
  if (!Number.isFinite(rate) || rate < -100) return null;
  const result = latest * Math.pow(1 + rate / 100, 5);
  return Number.isFinite(result) ? result : null;
}
