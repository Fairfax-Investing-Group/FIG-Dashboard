import type { Company } from './SearchPage';
import type { StudyDocument } from './types';

const CACHE_NAME = 'fig-study-documents-v1';
const PREFIX = 'https://fig-study-cache.invalid/studies/';
const FRESH_MS = 5 * 60_000;
const TTL_MS = 7 * 24 * 60 * 60_000;
type Options = { storage?: CacheStorage | null; now?: () => number; maxEntries?: number; maxBytes?: number; ttl?: number };
const valid = (value: StudyDocument) => value?.SchemaVersion === 1 && typeof value.Study?.StudyID === 'string'
  && typeof value.Company?.Ticker === 'string' && Array.isArray(value.AnnualData) && Array.isArray(value.DailyPrices)
  && Boolean(value.ComputedValues && value.Metadata?.Sources?.SEC && value.Metadata.Sources.YahooFinance && value.Metadata.EPSAdjustment)
  && Array.isArray(value.Metadata.Warnings);
const companyMatches = (document: StudyDocument, company: Pick<Company, 'ticker' | 'cik'>) => document.Company?.Ticker === company.ticker
  && Number(document.Company.CentralIndexKey) === company.cik;

/** Four decoded documents in memory; bounded provider-only snapshots on disk.
 * Cache Storage is asynchronous and optional (private/blocked storage still works).
 * User inputs and sessions are never written here.
 */
export class StudyCache extends Map<string, StudyDocument> {
  private savedAt = new WeakMap<StudyDocument, number>();
  private disk?: Promise<Cache | null>;
  private writes = Promise.resolve();
  constructor(private readonly limit = 4, private readonly options: Options = {}) { super(); }
  private now() { return (this.options.now ?? Date.now)(); }
  private storage() {
    return this.disk ??= (async () => {
      try { return await (this.options.storage === undefined ? globalThis.caches : this.options.storage)?.open(CACHE_NAME) ?? null; }
      catch { return null; }
    })();
  }
  private remember(id: string, value: StudyDocument, savedAt: number) {
    super.delete(id); super.set(id, value); this.savedAt.set(value, savedAt);
    while (this.size > this.limit) super.delete(this.keys().next().value!);
    return value;
  }
  get(id: string) {
    const value = super.get(id);
    if (value) { super.delete(id); super.set(id, value); }
    return value;
  }
  isFresh(document: StudyDocument) { return this.now() - (this.savedAt.get(document) ?? 0) < FRESH_MS; }
  findCompany(company: Pick<Company, 'ticker' | 'cik'>) {
    return [...this.values()].filter(document => companyMatches(document, company))
      .sort((a, b) => Date.parse(b.Study.DateCreated) - Date.parse(a.Study.DateCreated))[0];
  }
  set(id: string, value: StudyDocument, persist = true): this {
    const savedAt = this.now();
    this.remember(id, value, savedAt);
    if (persist && value.Study.StudyID === id) this.saveToDisk(value, savedAt);
    return this;
  }
  warm(value: StudyDocument) {
    // Speculative holdings may fill empty slots, but never evict recent studies.
    if (this.has(value.Study.StudyID) || this.size < this.limit) this.set(value.Study.StudyID, value);
    else this.saveToDisk(value, this.now());
  }
  private saveToDisk(value: StudyDocument, savedAt: number) {
    if (valid(value)) this.enqueue(async () => {
      const cache = await this.storage();
      if (!cache) return;
      const body = JSON.stringify(value), bytes = new TextEncoder().encode(body).byteLength;
      if (bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) return;
      await cache.put(PREFIX + encodeURIComponent(value.Study.StudyID), new Response(body, { headers: {
        'Content-Type': 'application/json', 'X-Study-Saved-At': String(savedAt), 'X-Study-Used-At': String(savedAt),
        'X-Study-Bytes': String(bytes), 'X-Study-Ticker': value.Company.Ticker,
        'X-Study-Cik': value.Company.CentralIndexKey, 'X-Study-Date': value.Study.DateCreated,
      } }));
      await this.prune(cache);
    });
  }
  private enqueue(work: () => Promise<void>) { this.writes = this.writes.then(work).catch(() => { /* Cache failures must never block a study. */ }); }
  flush() { return this.writes; }
  private async prune(cache: Cache) {
    const entries = await Promise.all((await cache.keys()).map(async key => ({ key, response: await cache.match(key) })));
    const live = entries.filter(entry => entry.response).sort((a, b) => Number(b.response!.headers.get('X-Study-Used-At')) - Number(a.response!.headers.get('X-Study-Used-At')));
    let count = 0, bytes = 0;
    for (const { key, response } of live) {
      const savedAt = Number(response!.headers.get('X-Study-Saved-At'));
      const size = Number(response!.headers.get('X-Study-Bytes'));
      if (!savedAt || this.now() - savedAt >= (this.options.ttl ?? TTL_MS)
        || count >= (this.options.maxEntries ?? 24) || bytes + size > (this.options.maxBytes ?? 16 * 1024 * 1024)) {
        await cache.delete(key);
      } else { count++; bytes += size; }
    }
  }
  private async read(cache: Cache, key: Request | string, response?: Response, retain = true) {
    try {
      response ??= await cache.match(key);
      if (!response) return;
      const savedAt = Number(response.headers.get('X-Study-Saved-At'));
      if (!savedAt || this.now() - savedAt >= (this.options.ttl ?? TTL_MS)) { await cache.delete(key); return; }
      const document = await response.json() as StudyDocument;
      if (!valid(document) || PREFIX + encodeURIComponent(document.Study.StudyID) !== (typeof key === 'string' ? key : key.url)) {
        await cache.delete(key); return;
      }
      const newer = super.get(document.Study.StudyID);
      if (newer && (this.savedAt.get(newer) ?? 0) >= savedAt) return newer;
      this.savedAt.set(document, savedAt);
      if (!retain) return document;
      this.remember(document.Study.StudyID, document, savedAt);
      // Touch only disk restores, rather than rewriting the document on every render.
      this.enqueue(async () => {
        const current = await cache.match(key);
        if (!current || current.headers.get('X-Study-Saved-At') !== String(savedAt)) return;
        const headers = new Headers(current.headers); headers.set('X-Study-Used-At', String(this.now()));
        await cache.put(key, new Response(current.body, { headers }));
      });
      return document;
    } catch { await cache.delete(key).catch(() => {}); return; }
  }
  async restore(id: string, retain = true) {
    const memory = retain ? this.get(id) : super.get(id);
    if (memory) return memory;
    await this.flush();
    const cache = await this.storage();
    if (cache) return this.read(cache, PREFIX + encodeURIComponent(id), undefined, retain);
  }
  async restoreCompany(company: Pick<Company, 'ticker' | 'cik'>) {
    const memory = this.findCompany(company);
    if (memory) return memory;
    await this.flush();
    const cache = await this.storage();
    if (!cache) return;
    try {
      const entries = await Promise.all((await cache.keys()).map(async key => ({ key, response: await cache.match(key) })));
      const matches = entries.filter(({ response }) => response?.headers.get('X-Study-Ticker') === company.ticker && Number(response.headers.get('X-Study-Cik')) === company.cik)
        .sort((a, b) => Date.parse(b.response!.headers.get('X-Study-Date') ?? '') - Date.parse(a.response!.headers.get('X-Study-Date') ?? ''));
      for (const { key, response } of matches) {
        const document = await this.read(cache, key, response);
        if (document && companyMatches(document, company)) return document;
      }
    } catch { /* Storage may be cleared or disabled while a page is open. */ }
  }
}
