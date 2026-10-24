import type { Company } from './SearchPage';
import type { Study } from './types';

/** Known identity only: no guessed currencies, reporting periods, or figures. */
export function pendingStudy(company: Company, id: string): Study {
  const source = { status: 'loading' as const, url: '', retrievedAt: null, error: null };
  return {
    id, company, createdAt: new Date().toISOString(), financialCurrency: null, priceCurrency: null,
    annual: [], quarterly: [], prices: [], priceInterval: '1wk',
    sources: { sec: { ...source }, yfinance: { ...source } }, warnings: [],
  };
}

// Keep known identity available before the saved document returns after a reload.
export function rememberStudyCompany(id: string, company: Company) {
  try { window.localStorage.setItem(`study-company:${id}`, JSON.stringify(company)); } catch { /* Storage may be unavailable. */ }
}

export function unknownPendingStudy(id: string): Study {
  try {
    const company = JSON.parse(window.localStorage.getItem(`study-company:${id}`) ?? 'null');
    if (company && typeof company.ticker === 'string' && typeof company.name === 'string' && typeof company.cik === 'number') {
      return pendingStudy({ ...company, exchange: typeof company.exchange === 'string' ? company.exchange : null }, id);
    }
  } catch { /* Fall back to blank identity until the saved document arrives. */ }
  return pendingStudy({ ticker: '', name: '—', cik: 0, exchange: null }, id);
}
