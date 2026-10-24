begin;

-- All saved inputs are public. Creation, updates and deletion stay owner-only.
drop policy if exists studies_select_own on public.studies;
create policy studies_select_public on public.studies
  for select to anon, authenticated using (true);
grant select on table public.studies to anon;

-- Keep existing insert/update/delete ownership checks and column grants intact.
commit;
