import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';

test('Postgres permits public study reads while restricting writes to the creator', async () => {
  const db = new PGlite();
  try {
    // Supabase-owned auth primitives are supplied locally for this actual Postgres check.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into auth.users values ('${alice}'), ('${bob}');
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/202610240001_user_studies.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610240002_study_made_at.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610240003_public_study_reads.sql', import.meta.url), 'utf8'));
    const asUser = async id => db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${id}';`);
    await asUser(alice);
    const { rows: [saved] } = await db.query("insert into public.studies(ticker,cik,eps_growth_percent,manual_low_price,high_pe_years,excluded_years,study_made_at) values ('AAPL',320193,12,0,5,array[2020],'2026-10-01T12:00:00Z') returning *");
    assert.equal(saved.user_id, alice);
    assert.equal(new Date(saved.study_made_at).toISOString(), '2026-10-01T12:00:00.000Z');
    assert.ok(new Date(saved.created_at) >= new Date(saved.study_made_at));
    assert.equal(Number(saved.eps_growth_percent), 12);
    assert.equal(Number(saved.manual_low_price), 0, 'Explicit zero must remain a user value');
    assert.equal(saved.annual_dividend, null, 'Calculated defaults are not stored');
    assert.equal(saved.high_pe, null, 'Linked P/E stores the selected period, not a calculated value');
    await db.exec(`update public.studies set notes = 'My research notes' where id = '${saved.id}';`);
    assert.equal((await db.query(`select notes from public.studies where id = '${saved.id}'`)).rows[0].notes, 'My research notes');
    await assert.rejects(db.exec(`update public.studies set user_id = '${bob}' where id = '${saved.id}';`), /permission denied/);
    await assert.rejects(db.exec(`update public.studies set created_at = now() where id = '${saved.id}';`), /permission denied/);
    await assert.rejects(db.exec("insert into public.studies(ticker,cik,annual_dividend) values ('AAPL',320193,'NaN');"), /studies_finite_numbers/);
    await assert.rejects(db.exec("insert into public.studies(ticker,cik,eps_growth_percent) values ('AAPL',320193,'Infinity');"), /studies_finite_numbers/);
    await assert.rejects(db.exec("insert into public.studies(ticker,cik,high_pe_years) values ('AAPL',320193,7);"), /check constraint/);
    await assert.rejects(db.exec("insert into public.studies(ticker,cik,\"AnnualData\") values ('AAPL',320193,'{}');"), /does not exist/);
    await assert.rejects(db.exec(`update public.studies set study_made_at = now() where id = '${saved.id}';`), /permission denied/);
    const afterSave = (await db.query(`select * from public.studies where id = '${saved.id}'`)).rows[0];
    assert.equal(String(afterSave.study_made_at), String(saved.study_made_at));
    assert.ok(new Date(afterSave.updated_at) >= new Date(saved.updated_at));
    await asUser(bob);
    assert.equal((await db.query(`select * from public.studies where id = '${saved.id}'`)).rows.length, 1, 'Other accounts can view the study');
    assert.equal((await db.query(`update public.studies set notes = 'Other user' where id = '${saved.id}' returning id`)).rows.length, 0);
    assert.equal((await db.query(`delete from public.studies where id = '${saved.id}' returning id`)).rows.length, 0);
    await assert.rejects(db.exec(`insert into public.studies(user_id,ticker,cik) values ('${alice}','AAPL',320193);`), /permission denied/);
    await db.exec('reset role; set role anon;');
    assert.equal((await db.query('select * from public.studies')).rows.length, 1, 'Logged-out visitors can view studies');
    await assert.rejects(db.exec(`update public.studies set notes = 'Anonymous edit' where id = '${saved.id}'`), /permission denied/);
    await assert.rejects(db.exec(`delete from public.studies where id = '${saved.id}'`), /permission denied/);
    await assert.rejects(db.exec("insert into public.studies(ticker,cik) values ('AAPL',320193);"), /permission denied/);
    // RLS must still deny cross-account writes even if grants are broadened later.
    await db.exec('reset role; grant insert(user_id), update(user_id) on public.studies to authenticated;');
    await asUser(bob);
    await assert.rejects(db.exec(`insert into public.studies(user_id,ticker,cik) values ('${alice}','AAPL',320193);`), /row-level security/);
    await asUser(alice);
    await assert.rejects(db.exec(`update public.studies set user_id = '${bob}' where id = '${saved.id}';`), /row-level security/);
    await db.exec(`reset role; delete from auth.users where id = '${alice}';`);
    assert.equal((await db.query('select * from public.studies')).rows.length, 0, 'Deleting the account deletes its inputs');
  } finally { await db.close(); }
});
