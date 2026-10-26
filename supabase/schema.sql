-- Trip Split database setup. Run in the Supabase SQL editor (Dashboard > SQL Editor > New query).
--
-- Access model
--   * People sign in with an emailed one-time code (Supabase Auth).
--   * A "group" is you and the people you travel with. It holds trips, people and expenses.
--   * Only email addresses listed in group_members can read or change a group's data.
--     The database enforces this (row-level security), not just the app.
--
-- Safe to re-run. The first run replaces the earlier link-based tables, if present;
-- that deletes any test data saved with the earlier version.

-- ---------- remove the earlier link-based version (only if it is still there) ----------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'trips' and column_name = 'group_id' and data_type = 'text')
     or exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'entries' and column_name = 'trip_id' and data_type = 'text') then
    drop table if exists public.entries cascade;
    drop table if exists public.trips cascade;
    drop table if exists public.parties cascade;
  end if;
end $$;
drop function if exists public.request_group_id();
drop function if exists public.request_trip_id();

-- ---------- groups and who may sign in to them ----------
create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Our trips',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  email     text not null check (email = lower(email) and position('@' in email) > 1),
  role      text not null default 'member' check (role in ('owner', 'member')),
  added_at  timestamptz not null default now(),
  primary key (group_id, email)
);
create index if not exists group_members_email_idx on public.group_members (email);

-- Access-check helpers live in a "private" schema that the API doesn't expose;
-- the access rules below still use them.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- The signed-in user's verified email, lower-cased.
create or replace function private.my_email() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- security definer so rules can check membership without recursing into row-level security.
create or replace function private.is_member(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m where m.group_id = g and m.email = private.my_email())
$$;

create or replace function private.is_owner(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m where m.group_id = g and m.email = private.my_email() and m.role = 'owner')
$$;

-- Same check for storage paths, whose first folder is the group id.
create or replace function private.is_member_path(folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select folder ~ '^[0-9a-f-]{36}$' and private.is_member(folder::uuid)
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- Creating a group makes the caller its owner, in one step. Public on purpose: the app calls it.
create or replace function public.create_group(group_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
  me text := private.my_email();
begin
  if auth.uid() is null or me = '' then
    raise exception 'Sign in first';
  end if;
  insert into public.groups (name, created_by)
  values (coalesce(nullif(trim(group_name), ''), 'Our trips'), auth.uid())
  returning id into gid;
  insert into public.group_members (group_id, email, role) values (gid, me, 'owner');
  return gid;
end $$;

revoke all on function public.create_group(text) from public, anon;
grant execute on function public.create_group(text) to authenticated;

-- ---------- trip data ----------
-- People. Shared across all of the group's trips.
create table if not exists public.parties (
  id          uuid primary key,
  group_id    uuid not null references public.groups(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  color       integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Trips. member_ids = the trip's frequent participants (people who appear in its expenses).
create table if not exists public.trips (
  id          uuid primary key,
  group_id    uuid not null references public.groups(id) on delete cascade,
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
  group_id      uuid not null references public.groups(id) on delete cascade,
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

-- ---------- row-level security ----------
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.parties       enable row level security;
alter table public.trips         enable row level security;
alter table public.entries       enable row level security;

drop policy if exists "members read group"  on public.groups;
drop policy if exists "owners rename group" on public.groups;
drop policy if exists "owners delete group" on public.groups;
create policy "members read group"  on public.groups for select to authenticated using (private.is_member(id));
create policy "owners rename group" on public.groups for update to authenticated using (private.is_owner(id)) with check (private.is_owner(id));
create policy "owners delete group" on public.groups for delete to authenticated using (private.is_owner(id));
-- (Groups are created only through create_group().)

drop policy if exists "members see members"   on public.group_members;
drop policy if exists "members add members"   on public.group_members;
drop policy if exists "remove member or leave" on public.group_members;
create policy "members see members" on public.group_members for select to authenticated
  using (private.is_member(group_id));
create policy "members add members" on public.group_members for insert to authenticated
  with check (private.is_member(group_id) and role = 'member');
create policy "remove member or leave" on public.group_members for delete to authenticated
  using (role <> 'owner' and (private.is_owner(group_id) or email = private.my_email()));

do $$
declare t text;
begin
  foreach t in array array['parties', 'trips', 'entries'] loop
    execute format('drop policy if exists "group members only" on public.%I', t);
    execute format('create policy "group members only" on public.%I for all to authenticated using (private.is_member(group_id)) with check (private.is_member(group_id))', t);
  end loop;
end $$;

-- Nothing is readable without signing in.
revoke all on public.groups, public.group_members, public.parties, public.trips, public.entries from anon;

-- ---------- receipt photos (private) ----------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;

drop policy if exists "receipt uploads"        on storage.objects;
drop policy if exists "members upload receipts" on storage.objects;
drop policy if exists "members view receipts"   on storage.objects;
drop policy if exists "members delete receipts" on storage.objects;
create policy "members upload receipts" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and private.is_member_path((storage.foldername(name))[1]));
create policy "members view receipts" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and private.is_member_path((storage.foldername(name))[1]));
create policy "members delete receipts" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and private.is_member_path((storage.foldername(name))[1]));

-- Earlier versions kept the helpers in public; remove them (after the rules above stop using them).
drop function if exists public.is_member_path(text);
drop function if exists public.is_owner(uuid);
drop function if exists public.is_member(uuid);
drop function if exists public.my_email();
