/** Annualized Sharpe of the stored cumulative fund-return series; 0% risk-free by default. */
export function portfolioSharpe(history: { date: string; club: number }[], annualRiskFreeRate = 0): number | null {
  if (!Number.isFinite(annualRiskFreeRate) || annualRiskFreeRate <= -1) return null;
  const ordered = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const dailyRiskFree = Math.pow(1 + annualRiskFreeRate, 1 / 252) - 1;
  const returns: number[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], current = ordered[index];
    if (current.date === previous.date || !Number.isFinite(previous.club) || !Number.isFinite(current.club) || previous.club <= -1 || current.club <= -1) return null;
    returns.push((1 + current.club) / (1 + previous.club) - 1 - dailyRiskFree);
  }
  if (returns.length < 60) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  if (variance <= 1e-20) return null;
  const sharpe = mean / Math.sqrt(variance) * Math.sqrt(252);
  return Number.isFinite(sharpe) ? sharpe : null;
}

/** Reconstruct prior-close values; current weights give the wrong aggregate daily return. */
export function portfolioDayChange(holdings: { marketValue: number; dayChange: number }[], cash: number): number | null {
  if (!holdings.length || !Number.isFinite(cash)) return null;
  let current = cash, previous = cash;
  for (const holding of holdings) {
    if (!Number.isFinite(holding.marketValue) || holding.marketValue < 0 || !Number.isFinite(holding.dayChange) || holding.dayChange <= -1) return null;
    current += holding.marketValue;
    previous += holding.marketValue / (1 + holding.dayChange);
  }
  return previous > 0 ? current / previous - 1 : null;
}

/** Daily fund/benchmark returns, since inception, independent of the chart's selected period. */
export function portfolioRiskMetrics(history: { date: string; club: number; benchmark: number }[]) {
  const unavailable = { sortino: null, maxDrawdown: null, volatility: null, informationRatio: null };
  const points = [...history].sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length || points.some((point, index) => !Number.isFinite(point.club) || !Number.isFinite(point.benchmark)
    || point.club <= -1 || point.benchmark <= -1 || (index > 0 && point.date === points[index - 1].date))) return unavailable;
  let peak = 1, maxDrawdown = 0;
  const returns: number[] = [], active: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index], wealth = 1 + point.club;
    peak = Math.max(peak, wealth);
    maxDrawdown = Math.max(maxDrawdown, 1 - wealth / peak);
    if (index === 0) continue;
    const previous = points[index - 1];
    const daily = wealth / (1 + previous.club) - 1;
    returns.push(daily);
    active.push(daily - ((1 + point.benchmark) / (1 + previous.benchmark) - 1));
  }
  if (returns.length < 60) return { ...unavailable, maxDrawdown };
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = (values: number[]) => {
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
  };
  const downside = Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length);
  const trackingError = deviation(active);
  return {
    sortino: downside > 1e-10 ? mean(returns) / downside * Math.sqrt(252) : null,
    maxDrawdown,
    volatility: deviation(returns) * Math.sqrt(252),
    informationRatio: trackingError > 1e-10 ? mean(active) / trackingError * Math.sqrt(252) : null,
  };
}
