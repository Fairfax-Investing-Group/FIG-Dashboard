// Minimal Cache Storage adapter with real Response cloning/stream semantics.
export function testCacheStorage() {
  const entries = new Map();
  const url = request => typeof request === 'string' ? request : request.url;
  const cache = {
    async put(request, response) { entries.set(url(request), response.clone()); },
    async match(request) { return entries.get(url(request))?.clone(); },
    async keys() { return [...entries.keys()].map(key => new Request(key)); },
    async delete(request) { return entries.delete(url(request)); },
  };
  return { entries, cache, async open() { return cache; } };
}
export function cachedDocument(id = '11111111-1111-4111-8111-111111111111', ticker = 'TEST', cik = 123) {
  const source = { Status: 'ok', URL: '', RetrievedAt: null, Error: null };
  return {
    SchemaVersion: 1, Study: { StudyID: id, DateCreated: '2026-10-25T00:00:00Z' },
    Company: { Ticker: ticker, CompanyName: 'Cached company', CentralIndexKey: String(cik), ExchangeType: 'Nasdaq' },
    AnnualData: [], QuarterlyData: [], DailyPrices: [], ComputedValues: {},
    Metadata: { DataStage: 'complete', FinancialCurrency: 'USD', PriceCurrency: 'USD', Warnings: [],
      Sources: { SEC: source, YahooFinance: source }, EPSAdjustment: { Status: 'normalized', Events: [] } },
  };
}
