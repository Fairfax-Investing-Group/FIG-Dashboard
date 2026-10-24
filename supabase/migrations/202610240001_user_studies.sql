begin;

-- Company selection and user-entered overrides only; provider documents stay local.
create table public.studies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,14}$'),
  cik bigint not null check (cik between 1 and 9999999999),
  title text check (char_length(title) <= 160),
  notes text check (char_length(notes) <= 20000),
  sales_growth_percent numeric check (sales_growth_percent >= -100),
  eps_growth_percent numeric check (eps_growth_percent >= -100),
  high_price_method text check (high_price_method in ('pe', 'manual')),
  manual_high_price numeric check (manual_high_price >= 0.01),
  high_pe numeric check (high_pe >= 0),
  high_pe_years smallint check (high_pe_years in (5, 10)),
  low_price_method text check (low_price_method in ('pe', 'recent', 'average', 'dividend', 'manual')),
  manual_low_price numeric check (manual_low_price >= 0),
  low_pe numeric check (low_pe >= 0),
  low_pe_years smallint check (low_pe_years in (5, 10)),
  low_eps_mode text check (low_eps_mode in ('auto', 'manual')),
  low_eps numeric check (low_eps >= 0),
  zone_split text check (zone_split in ('25-50-25', 'thirds')),
  annual_dividend numeric check (annual_dividend >= 0),
  payout_percent numeric check (payout_percent >= 0),
  high_yield_percent numeric check (high_yield_percent >= 0),
  desired_ratio numeric check (desired_ratio >= 0),
  target_return_percent numeric check (target_return_percent >= -100),
  excluded_years integer[] not null default '{}',
  excluded_values text[] not null default '{}',
  management_excluded_years integer[] not null default '{}',
  management_excluded_values text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studies_finite_numbers check (not (array[
    sales_growth_percent, eps_growth_percent, manual_high_price, high_pe, manual_low_price,
    low_pe, low_eps, annual_dividend, payout_percent, high_yield_percent, desired_ratio, target_return_percent
  ] && array['NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric])),
  constraint studies_exclusion_limits check (
    cardinality(excluded_years) <= 500 and cardinality(excluded_values) <= 500
    and cardinality(management_excluded_years) <= 500 and cardinality(management_excluded_values) <= 500
  )
);

comment on table public.studies is 'User-owned study inputs. Never store SEC facts, Yahoo quotes, prices, financial statements, or computed results.';
comment on column public.studies.high_pe_years is 'User selection of 5/10-year reference; the calculated P/E value is not stored.';
comment on column public.studies.annual_dividend is 'Explicit manual override only. NULL uses the current calculated five-year average.';

create index studies_owner_updated_idx on public.studies (user_id, updated_at desc);
alter table public.studies enable row level security;
alter table public.studies force row level security;

create policy studies_select_own on public.studies for select to authenticated using ((select auth.uid()) = user_id);
create policy studies_insert_own on public.studies for insert to authenticated with check ((select auth.uid()) = user_id);
create policy studies_update_own on public.studies for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy studies_delete_own on public.studies for delete to authenticated using ((select auth.uid()) = user_id);

create function public.studies_set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.studies_set_updated_at() from public, anon, authenticated;
create trigger studies_updated_at before update on public.studies for each row execute function public.studies_set_updated_at();

revoke all on table public.studies from public, anon, authenticated;
grant select, delete on table public.studies to authenticated;
-- Ownership, identity and timestamps are assigned by Postgres, never by the client.
grant insert (
  ticker, cik, title, notes, sales_growth_percent, eps_growth_percent, high_price_method,
  manual_high_price, high_pe, high_pe_years, low_price_method, manual_low_price, low_pe,
  low_pe_years, low_eps_mode, low_eps, zone_split, annual_dividend, payout_percent,
  high_yield_percent, desired_ratio, target_return_percent, excluded_years, excluded_values,
  management_excluded_years, management_excluded_values
) on public.studies to authenticated;
grant update (
  ticker, cik, title, notes, sales_growth_percent, eps_growth_percent, high_price_method,
  manual_high_price, high_pe, high_pe_years, low_price_method, manual_low_price, low_pe,
  low_pe_years, low_eps_mode, low_eps, zone_split, annual_dividend, payout_percent,
  high_yield_percent, desired_ratio, target_return_percent, excluded_years, excluded_values,
  management_excluded_years, management_excluded_values
) on public.studies to authenticated;
grant all on table public.studies to service_role;

commit;
