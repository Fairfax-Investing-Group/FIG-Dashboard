# Supabase authentication and study storage

Both the homepage investor login and `#/login` use Supabase email/password
sign-in. The app restores sessions, refreshes tokens, follows auth state changes,
and supports logout. Company research stays available without signing in.

## Configure the browser client

Copy `.env.example` to `.env.local` and set:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
```

The legacy `VITE_SUPABASE_ANON_KEY` is also supported. These are public project
settings. A secret/service-role key and database password must never be included
in a `VITE_` variable. `.env.local` is ignored by Git. Restart `npm run dev` after
changing settings. Production builds need these variables set **at build time**.

Enable the email provider in Supabase Authentication and create the intended
accounts in Authentication > Users. This implementation signs existing users in;
it does not add public registration or a password-recovery flow.

## Apply the database infrastructure

Run the entire contents of
[`202610240001_user_studies.sql`](../supabase/migrations/202610240001_user_studies.sql)
in the project's Supabase SQL Editor once. Then run
[`202610240002_study_made_at.sql`](../supabase/migrations/202610240002_study_made_at.sql)
to add the immutable original study date. If the first migration is already
applied, run only the second migration. If using the Supabase CLI with a linked
project, `supabase db push` applies the same versioned migration.

The browser publishable key cannot create database tables or apply migrations.
Use the SQL Editor or your normal privileged migration connection. There is no
service-role key in the frontend or the Python backend.

## Storage boundary

`public.studies` contains:

- The company selected by the user (`ticker`, `cik`). No company profile is copied.
- User-authored title/notes and explicit sales/EPS growth forecasts.
- Manual high/low prices, P/E and EPS overrides, dividend/payout/yield overrides,
  desired upside/downside ratio, and target return.
- User-selected calculation methods, zone split, and 5/10-year P/E links.
- Excluded years/values for Fundamentals/Valuation and, separately, Management.
- Original study creation time (`study_made_at`), taken from the opened study.
- Database-generated record ID, owner ID, first-save time (`created_at`), and
  latest-save time (`updated_at`). The original date and first-save time stay
  unchanged on subsequent saves.

The original maker is stored as `user_id`, assigned from `auth.uid()` when the
study is first saved. Clients cannot supply or change it. Both the saved-study
list and the open study show the maker's current account email (falling back to
the stored user ID). The ID remains the stable identity if the email changes.

**NULL means automatic:** do not save a calculated default simply because it is
visible in an input. For example, an untouched annual dividend stays NULL; a
5-year P/E link stores `high_pe_years = 5` with `high_pe = NULL`, so the linked
average is recalculated when data or exclusions change. Explicit manual zero is
preserved. Clearing an override should send NULL. Resetting exclusions sends `[]`.
Numeric rate inputs are percentages (12 means 12%, not 0.12). Financial fields
have no numeric defaults. The database rejects nonfinite numbers.

There is no cloud column for SEC facts, Yahoo data, annual/quarterly statements,
prices, calculated averages, chart series, or complete StudyDocument JSON.
`validateStudyValues()` rejects unknown keys at runtime, including ownership and
server-owned timestamps. SQL grants prevent clients assigning ownership or
save timestamps, or changing the original study date after insertion.

Existing `.data/studies.sqlite3` files remain local provider snapshots used by the
research API. They are separate from Supabase and are not uploaded or migrated.

## Save and open

`src/lib/studyRepository.ts` exposes `createStudyRepository()` with `list()`,
`get(id)`, `create(values)`, `update(id, patch)`, and `remove(id)` methods. Each
method requires a signed-in session. Postgres row-level security independently
enforces ownership for reads, inserts, updates and deletes. Account deletion
cascades to that user's input records.

```ts
import { createStudyRepository } from '../lib/studyRepository';

const studies = createStudyRepository();
const saved = await studies.create({
  ticker: 'AAPL', cik: 320193, title: 'My Apple assumptions',
  eps_growth_percent: 12, high_pe_years: 5,
});
await studies.update(saved.id, { manual_low_price: 0 });
```

The study page's **Save study** button gathers explicit forecasts, valuation
assumptions, and both financial and management exclusions. Save again to update
the same cloud record. Refreshing a saved study retains its inputs and cloud
identity while replacing provider data. A logged-out user can sign in beside the save action
without leaving the study. Invalid input or failed writes leave the draft intact
and display an error. There is no autosave; preloads never create Supabase rows.

The homepage's **Saved studies** list is private to the signed-in user. Opening
a record restores all stored inputs into a fresh local company snapshot. Null
overrides continue using fresh calculated defaults, and linked P/E periods are
recalculated from fresh history. The saved original date stays unchanged.
Saving a new search result creates a separate saved record, even for the same
company. The page shows the original study date and latest save date.

## Focused checks

```sh
node --test scripts/supabaseAuth.test.mjs scripts/studyRepository.test.mjs scripts/supabaseStorage.test.mjs scripts/saveStudy.test.mjs
npm run build
```

The migration test runs actual Postgres using PGlite with local stand-ins for
Supabase's auth roles and `auth.uid()`. It verifies ownership isolation, denied
anonymous access, protected ownership/timestamps, numeric validation, and account
cascade deletion. It does not apply the migration to a hosted project or log in a
real account.

Official references: [password sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithpassword),
[auth state changes](https://supabase.com/docs/reference/javascript/auth-onauthstatechange),
[row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
