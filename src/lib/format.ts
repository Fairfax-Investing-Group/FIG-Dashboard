// Reuse the expensive Intl instances across tables, charts, and prepared pages.
// Bound both caches so visiting many currencies/locales cannot retain them forever.
const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
function formatter<T>(cache: Map<string, T>, key: string, create: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  }
  return value;
}
export function numberFormatter(options: Intl.NumberFormatOptions, locale = 'en-US') {
  return formatter(numbers, JSON.stringify([locale, options]), () => new Intl.NumberFormat(locale, options));
}
export function dateFormatter(options: Intl.DateTimeFormatOptions, locale?: string) {
  return formatter(dates, JSON.stringify([locale, options]), () => new Intl.DateTimeFormat(locale, options));
}
export function formatNumber(value: number | null, digits = 2): string {
  return value === null ? '—' : numberFormatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
export function formatDate(value: Date, options: Intl.DateTimeFormatOptions, locale?: string): string {
  // Match Date.toLocaleString's behavior for unavailable/invalid provider dates.
  return Number.isNaN(value.getTime()) ? value.toString() : dateFormatter(options, locale).format(value);
}
export const calendarDate = (date: string) => formatDate(new Date(`${date}T12:00:00Z`), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }, 'en-US');
export const marketDate = (date: string) => formatDate(new Date(date), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }, 'en-US');
