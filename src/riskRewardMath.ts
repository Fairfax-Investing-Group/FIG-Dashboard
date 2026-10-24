export type LowPriceMethod = 'pe' | 'recent' | 'average' | 'dividend' | 'manual';
export type ZoneSplit = '25-50-25' | 'thirds';
export type RiskInputs = {
  highPE: number | null; lowPE: number | null; highEPS: number | null; lowEPS: number | null;
  highMethod?: 'pe' | 'manual'; manualHigh?: number | null;
  currentPrice: number | null; annualDividend: number | null; payoutPercent: number | null; highYieldPercent: number | null;
  averageLow: number | null; recentLow: number | null; manualLow: number | null; lowMethod: LowPriceMethod;
  zoneSplit: ZoneSplit; desiredRatio: number | null; targetReturnPercent: number | null;
};
const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const positive = (value: number | null | undefined): value is number => finite(value) && value > 0;
const nonnegative = (value: number | null | undefined): value is number => finite(value) && value >= 0;
const checked = (value: number) => Number.isFinite(value) ? value : null;
export function assumption(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return nonnegative(number) ? number : null;
}

export function riskReward(inputs: RiskInputs) {
  const { highPE, lowPE, highEPS, lowEPS, currentPrice: price, annualDividend: dividend, payoutPercent: payout } = inputs;
  const highPrice = inputs.highMethod === 'manual'
    ? positive(inputs.manualHigh) ? inputs.manualHigh : null
    : positive(highPE) && positive(highEPS) ? checked(highPE * highEPS) : null;
  const forecastHighPE = inputs.highMethod === 'manual'
    ? positive(highPrice) && positive(highEPS) ? checked(highPrice / highEPS) : null
    : highPE;
  const peLow = positive(lowPE) && nonnegative(lowEPS) ? checked(lowPE * lowEPS) : null;
  const dividendLow = positive(dividend) && positive(inputs.highYieldPercent) ? checked(dividend / (inputs.highYieldPercent / 100)) : null;
  const candidates = { pe: peLow, recent: inputs.recentLow, average: inputs.averageLow, dividend: dividendLow, manual: inputs.manualLow };
  const selected = candidates[inputs.lowMethod];
  const lowPrice = nonnegative(selected) ? selected : null;
  const validRange = positive(highPrice) && nonnegative(lowPrice) && highPrice > lowPrice;
  const range = validRange ? highPrice - lowPrice : null;
  const fraction = inputs.zoneSplit === 'thirds' ? 1 / 3 : 0.25;
  const buyUpper = validRange ? lowPrice + range! * fraction : null;
  const sellLower = validRange ? highPrice - range! * fraction : null;
  const zone = !validRange ? (highPrice !== null && lowPrice !== null ? 'Check forecasts' : 'Awaiting inputs') : !positive(price) ? 'Price unavailable' : price <= buyUpper! ? 'Buy' : price >= sellLower! ? 'Sell' : 'Hold';
  const upsideDownside = validRange && positive(price) && price > lowPrice ? checked((highPrice - price) / (price - lowPrice)) : null;
  const appreciation = positive(highPrice) && positive(price) ? checked((highPrice / price - 1) * 100) : null;
  const averagePE = positive(forecastHighPE) && positive(lowPE) ? checked(forecastHighPE / 2 + lowPE / 2) : null;
  const averagePrice = positive(averagePE) && positive(highEPS) ? checked(averagePE * highEPS) : null;
  const currentYield = nonnegative(dividend) && positive(price) ? checked(dividend / price * 100) : null;
  const highPEYield = payout === 0 ? 0 : nonnegative(payout) && positive(forecastHighPE) ? checked(payout / forecastHighPE) : null;
  const averagePEYield = nonnegative(payout) && positive(averagePE) ? checked(payout / averagePE) : null;
  const returns = (terminal: number | null, yieldPercent: number | null) => {
    const priceCAGR = positive(terminal) && positive(price) ? checked(((terminal / price) ** (1 / 5) - 1) * 100) : null;
    return { priceCAGR, averageYield: yieldPercent, annualReturn: priceCAGR !== null && yieldPercent !== null ? checked(priceCAGR + yieldPercent) : null };
  };
  const highReturns = returns(highPrice, highPEYield), averageReturns = returns(averagePrice, averagePEYield);
  const ratioBuyCap = validRange && nonnegative(inputs.desiredRatio) ? checked((highPrice + inputs.desiredRatio * lowPrice) / (1 + inputs.desiredRatio)) : null;
  const returnBase = inputs.targetReturnPercent !== null && highPEYield !== null ? 1 + inputs.targetReturnPercent / 100 - highPEYield / 100 : null;
  const returnBuyCap = positive(highPrice) && nonnegative(inputs.targetReturnPercent) && positive(returnBase) ? checked(highPrice / returnBase ** 5) : null;
  const buyPrice = ratioBuyCap !== null && returnBuyCap !== null ? Math.min(ratioBuyCap, returnBuyCap) : null;
  return { highPrice, forecastHighPE, lowPrice, candidates, averagePE, averagePrice, range, buyUpper, sellLower, zone, validRange, upsideDownside, appreciation,
    currentYield, highReturns, averageReturns, ratioBuyCap, returnBuyCap, buyPrice };
}
