begin;
alter table public.studies add column study_made_at timestamptz;
update public.studies set study_made_at = created_at;
alter table public.studies alter column study_made_at set default now();
alter table public.studies alter column study_made_at set not null;
comment on column public.studies.study_made_at is 'Original study creation time. created_at is first saved time; updated_at is most recent save.';
grant insert (study_made_at) on public.studies to authenticated;
-- Keep the original creation date immutable; existing RLS policies apply.
commit;
