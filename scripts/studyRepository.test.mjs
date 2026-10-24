import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';

test('cloud repository sends only explicit inputs through the authenticated Supabase client', async () => {
  const dir = await mkdtemp(new URL('../.data/repository-test-', import.meta.url));
  try {
    const outfile = `${dir}/repository.mjs`;
    await build({ entryPoints: ['src/lib/studyRepository.ts'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    const { createStudyRepository } = await import(pathToFileURL(outfile).href);
    const calls = [];
    const sdk = createClient('https://example.supabase.co', 'sb_publishable_test', {
      accessToken: async () => 'user-session-token',
      global: { fetch: async (url, options) => {
        calls.push({ url: String(url), ...options });
        return new Response(JSON.stringify({ id: 'saved-id', user_id: 'alice' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } },
    });
    const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'alice' } } }, error: null }) }, from: table => sdk.from(table) };
    const repository = createStudyRepository(client);
    const input = { study_made_at: '2026-10-20T12:00:00Z', ticker: 'AAPL', cik: 320193, eps_growth_percent: 12, manual_low_price: 0, annual_dividend: null, high_pe_years: 5, excluded_values: ['eps:2020', 'eps:2020'] };
    await repository.create(input);
    assert.deepEqual(JSON.parse(calls[0].body), { ...input, excluded_values: ['eps:2020'] });
    assert.equal(new Headers(calls[0].headers).get('Authorization'), 'Bearer user-session-token');
    assert.match(calls[0].url, /\/rest\/v1\/studies/);
    assert.equal(JSON.parse(calls[0].body).user_id, undefined, 'Postgres assigns ownership');
    await repository.update('saved-id', { high_pe_years: null, high_pe: 20, notes: 'My assumptions', study_made_at: '2026-10-21T12:00:00Z' });
    assert.deepEqual(JSON.parse(calls[1].body), { high_pe_years: null, high_pe: 20, notes: 'My assumptions' });
    assert.match(calls[1].url, /user_id=eq\.alice/);
    assert.match(calls[1].url, /id=eq\.saved-id/);
    for (const invalid of [
      { ...input, AnnualData: [] }, { ...input, prices: [] }, { ...input, user_id: 'bob' },
      { ...input, eps_growth_percent: NaN }, { ...input, high_pe: Infinity },
      { ...input, low_price_method: 'unsupported' }, { ...input, high_pe_years: 7 },
      { ...input, excluded_years: ['2020'] }, { ...input, study_made_at: 'not-a-date' }, { ...input, created_at: '2026-10-20T12:00:00Z' },
    ]) await assert.rejects(repository.create(invalid), /study input/);
    assert.equal(calls.length, 2, 'Invalid inputs must never reach Supabase');
    client.auth.getSession = async () => ({ data: { session: null }, error: null });
    await assert.rejects(repository.list(), /Log in/);
    await assert.rejects(repository.create(input), /Log in/);
    assert.equal(calls.length, 2);
    await assert.rejects(createStudyRepository(null).list(), /not configured/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
