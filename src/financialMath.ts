export function annualGrowth(first: number | null, last: number | null, start: string, end: string): number | null {
  if (first === null || last === null || first <= 0 || last <= 0) return null;
  const years = (Date.parse(end) - Date.parse(start)) / (365.2425 * 86_400_000);
  if (!Number.isFinite(years) || years <= 0) return null;
  const result = (Math.pow(last / first, 1 / years) - 1) * 100;
  return Number.isFinite(result) ? result : null;
}

export function fiveYearEstimate(latest: number | null, forecast: string): number | null {
  if (latest === null || !forecast.trim()) return null;
  const rate = Number(forecast);
  if (!Number.isFinite(rate) || rate < -100) return null;
  const result = latest * Math.pow(1 + rate / 100, 5);
  return Number.isFinite(result) ? result : null;
}
