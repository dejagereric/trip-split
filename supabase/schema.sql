-- Trip Split: run once in the Supabase SQL editor (Dashboard > SQL Editor > New query).
--
-- Everything belongs to a "group" (you and the people you travel with). The app sends
-- its group id in an `x-group-id` header, and row-level security only returns rows for
-- that group, so nobody can list other groups' data even with the public anon key.
-- The group id lives in the share link, never in the repo.
--
-- Upgrading from the first version (single trip)? Run `drop table if exists public.entries;`
-- first. That version's table had no trips.

create or replace function public.request_group_id() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-group-id', '')
$$;

-- People. Shared across all of the group's trips.
create table if not exists public.parties (
  id          uuid primary key,
  group_id    text not null check (length(group_id) >= 16),
  name        text not null,
  phone       text,
  email       text,
  color       integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Trips. member_ids = the trip's frequent participants (people who appear in its expenses).
create table if not exists public.trips (
  id          uuid primary key,
  group_id    text not null check (length(group_id) >= 16),
  name        text not null,
  currency    text not null default '$',
  start_on    date,
  end_on      date,
  member_ids  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- Expenses and settle-up payments. Each belongs to exactly one trip.
create table if not exists public.entries (
  id            uuid primary key,
  group_id      text not null check (length(group_id) >= 16),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  kind          text not null check (kind in ('expense', 'payment')),
  description   text,
  category      text,
  spent_on      date not null default current_date,
  amount_cents  integer not null check (amount_cents > 0),
  payer         uuid,
  shares        jsonb not null default '{}'::jsonb,
  split_mode    text,
  from_party    uuid,
  to_party      uuid,
  receipt_path  text,
  created_at    timestamptz not null default now()
);

create index if not exists parties_group_idx on public.parties (group_id);
create index if not exists trips_group_idx   on public.trips (group_id);
create index if not exists entries_trip_idx  on public.entries (trip_id, created_at);
create index if not exists entries_group_idx on public.entries (group_id);

do $$
declare t text;
begin
  foreach t in array array['parties', 'trips', 'entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "group read" on public.%I', t);
    execute format('drop policy if exists "group insert" on public.%I', t);
    execute format('drop policy if exists "group update" on public.%I', t);
    execute format('drop policy if exists "group delete" on public.%I', t);
    execute format('create policy "group read" on public.%I for select to anon using (group_id = public.request_group_id())', t);
    execute format('create policy "group insert" on public.%I for insert to anon with check (group_id = public.request_group_id())', t);
    execute format('create policy "group update" on public.%I for update to anon using (group_id = public.request_group_id()) with check (group_id = public.request_group_id())', t);
    execute format('create policy "group delete" on public.%I for delete to anon using (group_id = public.request_group_id())', t);
  end loop;
end $$;

-- Receipt photos: a public-read bucket with unguessable paths (<group id>/<uuid>.jpg).
-- Uploads are allowed; listing the bucket is not.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', true)
on conflict (id) do nothing;

drop policy if exists "receipt uploads" on storage.objects;
create policy "receipt uploads" on storage.objects for insert to anon
  with check (bucket_id = 'receipts');
