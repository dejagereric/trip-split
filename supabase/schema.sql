-- Trip Split: run once in the Supabase SQL editor (Dashboard > SQL Editor > New query).

create table if not exists public.entries (
  id            uuid primary key,
  trip_id       text not null check (length(trip_id) >= 16),
  kind          text not null check (kind in ('expense', 'payment')),
  description   text,
  category      text,
  spent_on      date not null default current_date,
  amount_cents  integer not null check (amount_cents > 0),
  payer         text,
  shares        jsonb not null default '{}'::jsonb,
  split_mode    text,
  from_party    text,
  to_party      text,
  receipt_path  text,
  created_at    timestamptz not null default now()
);

create index if not exists entries_trip_idx on public.entries (trip_id, created_at);

-- The app sends its trip id in an `x-trip-id` header. Rows are only visible to
-- requests carrying the matching id, so nobody can list other trips, even with
-- the public anon key. The trip id lives in the share link, never in the repo.
create or replace function public.request_trip_id() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-trip-id', '')
$$;

alter table public.entries enable row level security;

drop policy if exists "trip read"   on public.entries;
drop policy if exists "trip insert" on public.entries;
drop policy if exists "trip delete" on public.entries;

create policy "trip read"   on public.entries for select to anon using (trip_id = public.request_trip_id());
create policy "trip insert" on public.entries for insert to anon with check (trip_id = public.request_trip_id());
create policy "trip delete" on public.entries for delete to anon using (trip_id = public.request_trip_id());

-- Receipt photos: a public-read bucket with unguessable paths (<trip id>/<uuid>.jpg).
-- Uploads are allowed; listing the bucket is not.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', true)
on conflict (id) do nothing;

drop policy if exists "receipt uploads" on storage.objects;
create policy "receipt uploads" on storage.objects for insert to anon
  with check (bucket_id = 'receipts');
