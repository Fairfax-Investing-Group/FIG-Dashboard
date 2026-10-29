import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { testCacheStorage, cachedDocument } from './testCacheStorage.mjs';

async function modules(run) {
  const dir = await mkdtemp(new URL('../.data/persistence-test-', import.meta.url));
  try {
    const outfile = `${dir}/cache.mjs`;
    await build({ stdin: { contents: "export { StudyCache } from './src/studyCache'; export { preloadPortfolio } from './src/lib/portfolioPreload';", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.env.BASE_URL': JSON.stringify('/') } });
    await run(await import(pathToFileURL(outfile).href));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('recent studies survive reload, use both company identifiers, and evict disk entries by recency', () => modules(async ({ StudyCache }) => {
  const storage = testCacheStorage();
  let now = Date.now();
  const options = { storage, now: () => now, maxEntries: 3 };
  const first = new StudyCache(2, options);
  for (const id of ['one', 'two', 'three']) { now++; first.set(id, cachedDocument(id)); }
  await first.flush();
  assert.equal(first.size, 2);
  const reloaded = new StudyCache(2, options);
  assert.deepEqual(await reloaded.restore('one'), cachedDocument('one'));
  await reloaded.flush();
  now++; reloaded.set('four', cachedDocument('four', 'OTHER', 456)); await reloaded.flush();
  const next = new StudyCache(2, options);
  assert.equal(await next.restore('two'), undefined, 'Least recently used disk entry is evicted');
  assert.ok(await next.restore('one'), 'Reloading touched the older entry');
  assert.equal(await next.restoreCompany({ ticker: 'OTHER', cik: 999 }), undefined);
  assert.equal((await next.restoreCompany({ ticker: 'OTHER', cik: 456 })).Study.StudyID, 'four');
  assert.equal(storage.entries.size, 3);
}));

test('cache expiry, corrupt entries, size caps, and blocked storage never prevent live studies', () => modules(async ({ StudyCache }) => {
  const storage = testCacheStorage(); let now = Date.now();
  const options = { storage, now: () => now, ttl: 1000 };
  const first = new StudyCache(1, options);
  first.set('old', cachedDocument('old')); await first.flush();
  now += 1001;
  assert.equal(await new StudyCache(1, options).restore('old'), undefined);
  assert.equal(storage.entries.size, 0);
  first.set('broken', cachedDocument('broken')); await first.flush();
  const [key, response] = [...storage.entries][0];
  storage.entries.set(key, new Response('{invalid', { headers: response.headers }));
  assert.equal(await new StudyCache(1, options).restore('broken'), undefined);
  const small = new StudyCache(1, { storage, maxBytes: 10 });
  const large = cachedDocument('large'); small.set('large', large); await small.flush();
  assert.equal(storage.entries.size, 0); assert.equal(small.get('large'), large);
  const blocked = new StudyCache(1, { storage: { open() { throw new Error('Storage blocked'); } } });
  blocked.set('live', cachedDocument('live')); await blocked.flush();
  assert.ok(blocked.get('live')); assert.equal(await blocked.restore('missing'), undefined);
}));

test('portfolio warming loads every compact snapshot with two workers, pauses for search, and reuses disk cache', () => modules(async ({ StudyCache, preloadPortfolio }) => {
  const originalFetch = globalThis.fetch;
  const storage = testCacheStorage(), cache = new StudyCache(2, { storage });
  const studies = Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, id: String(i), file: `studies/T${i}.json`, viewFile: `studies/T${i}.view.json` }));
  cache.set('recent', cachedDocument('recent')); await cache.flush();
  let busy = true, active = 0, peak = 0, indexCalls = 0;
  const requested = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/studies/index.json') { indexCalls++; return Response.json({ studies }); }
    assert.ok(String(url).endsWith('.view.json'), 'Preload must avoid full provider documents');
    assert.equal(options.priority, 'low');
    requested.push(url); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    const i = Number(String(url).match(/T(\d+)/)[1]);
    return Response.json(cachedDocument(String(i), `T${i}`, i + 1));
  };
  try {
    const controller = new AbortController();
    const work = preloadPortfolio(cache, controller.signal, () => busy);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(indexCalls, 1, 'Warming is queued immediately'); assert.equal(requested.length, 0, 'Search has priority');
    busy = false; await work; await cache.flush();
    assert.equal(requested.length, 10); assert.equal(peak, 2); assert.equal(cache.size, 2);
    assert.ok(cache.get('recent'), 'Portfolio warming must not evict the most recent study from memory');
    await preloadPortfolio(new StudyCache(2, { storage }), controller.signal, () => false);
    assert.equal(requested.length, 10, 'Fresh persisted holdings require no repeat downloads');
    assert.equal(indexCalls, 1, 'All callers share the snapshot index');
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(preloadPortfolio(cache, stopped.signal, () => false), { name: 'AbortError' });
    let pending = 0;
    globalThis.fetch = (_url, { signal }) => {
      pending++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const navigating = new AbortController();
    const abandoned = preloadPortfolio(new StudyCache(2, { storage: testCacheStorage() }), navigating.signal, () => false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pending, 2);
    navigating.abort(); await abandoned;
    assert.equal(pending, 2, 'Leaving home cancels active requests and stops the remaining queue');
  } finally { globalThis.fetch = originalFetch; }
}));
