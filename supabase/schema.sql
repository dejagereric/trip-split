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
  role      text not null default 'user',
  added_at  timestamptz not null default now(),
  primary key (group_id, email)
);
create index if not exists group_members_email_idx on public.group_members (email);

-- Roles: 'admin' (Administrators: manage people and access) and 'user' (Users).
-- Earlier versions used 'owner' / 'member'; convert them.
alter table public.group_members drop constraint if exists group_members_role_check;
update public.group_members set role = case role when 'owner' then 'admin' when 'member' then 'user' else role end
  where role in ('owner', 'member');
alter table public.group_members alter column role set default 'user';
alter table public.group_members add constraint group_members_role_check check (role in ('admin', 'user'));

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

create or replace function private.is_admin(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m where m.group_id = g and m.email = private.my_email() and m.role = 'admin')
$$;

-- Never leave a group without an Administrator (unless the whole group is being deleted).
create or replace function private.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.groups g where g.id = old.group_id) then  -- deleting the whole group is fine
    if not exists (select 1 from public.group_members m
                   where m.group_id = old.group_id and m.role = 'admin' and m.email <> old.email) then
      raise exception 'A group needs at least one Administrator.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists keep_an_admin on public.group_members;
create trigger keep_an_admin before update or delete on public.group_members
  for each row execute function private.keep_an_admin();

-- Same check for storage paths, whose first folder is the group id.
create or replace function private.is_member_path(folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select folder ~ '^[0-9a-f-]{36}$' and private.is_member(folder::uuid)
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- App-wide settings, not exposed through the API.
create table if not exists private.settings (
  key   text primary key,
  value jsonb not null
);
revoke all on private.settings from public, anon, authenticated;
-- Group creation is closed: only people who already administer a group may create one.
-- To open it to everyone later:  update private.settings set value = 'true' where key = 'open_group_creation';
insert into private.settings (key, value) values ('open_group_creation', 'false') on conflict (key) do nothing;

create or replace function private.may_create_group() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select value = 'true'::jsonb from private.settings where key = 'open_group_creation'), false)
      or exists (select 1 from public.group_members m where m.email = private.my_email() and m.role = 'admin')
$$;
revoke all on function private.may_create_group() from public, anon;
grant execute on function private.may_create_group() to authenticated;

-- Lets the app ask whether to offer "Create group".
create or replace function public.can_create_group() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and private.may_create_group()
$$;
revoke all on function public.can_create_group() from public, anon;
grant execute on function public.can_create_group() to authenticated;

-- Creating a group makes the caller its Administrator, in one step. Public on purpose: the app calls it.
-- NOTE: the very first group in a brand-new project needs open_group_creation = true (or an insert by hand).
create or replace function public.create_group(group_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
  me text := private.my_email();
begin
  if auth.uid() is null or me = '' then
    raise exception 'Sign in first';
  end if;
  if not private.may_create_group() then
    raise exception 'Creating groups is limited to Administrators.' using errcode = '42501';
  end if;
  insert into public.groups (name, created_by)
  values (coalesce(nullif(trim(group_name), ''), 'Our trips'), auth.uid())
  returning id into gid;
  insert into public.group_members (group_id, email, role) values (gid, me, 'admin');
  perform private.seed_categories(gid);
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
  currency    text not null default 'USD',
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
-- Who entered each expense: filled in by the database from the signed-in user's email.
alter table public.entries
  add column if not exists created_by_email text default lower(coalesce(auth.jwt() ->> 'email', ''));

-- Multi-currency. A trip's `currency` is its ledger currency (ISO code); every entry's
-- amount_cents is in that currency. These columns record what was actually spent.
alter table public.entries
  add column if not exists orig_amount_cents integer,          -- amount in the currency paid
  add column if not exists orig_currency text,                 -- ISO code paid in
  add column if not exists fx_rate numeric(18, 8),             -- 1 orig_currency = fx_rate ledger currency
  add column if not exists fx_date date;                       -- date the rate is for
-- Earlier versions stored currency symbols; convert them to ISO codes.
update public.trips set currency = case currency
  when '$' then 'USD' when '€' then 'EUR' when '£' then 'GBP' when '¥' then 'JPY'
  when '₹' then 'INR' when 'A$' then 'AUD' when 'C$' then 'CAD' when 'CHF' then 'CHF'
  else currency end
where currency !~ '^[A-Z]{3}$';
alter table public.trips alter column currency set default 'USD';
-- Currencies the trip expects to spend in, in the order to offer them (USD and EUR first by default).
alter table public.trips add column if not exists currencies jsonb not null default '["USD","EUR"]'::jsonb;

create index if not exists parties_group_idx on public.parties (group_id);
create index if not exists trips_group_idx   on public.trips (group_id);
create index if not exists entries_trip_idx  on public.entries (trip_id, created_at);
create index if not exists entries_group_idx on public.entries (group_id);

-- Expense categories, shared by all of a group's trips. Entries keep the category name as text.
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (group_id, name)
);
create index if not exists categories_group_idx on public.categories (group_id, sort);

-- Starting list for a group.
create or replace function private.seed_categories(g uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.categories (group_id, name, sort)
  select g, c.name, c.sort from (values
    ('Lodging', 10), ('Food', 20), ('Transport', 30), ('Activities', 40), ('Groceries', 50),
    ('Yacht charter', 60), ('Boat expenses', 70), ('Other', 80)) as c(name, sort)
  on conflict (group_id, name) do nothing
$$;
revoke all on function private.seed_categories(uuid) from public, anon, authenticated;

-- ---------- row-level security ----------
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.parties       enable row level security;
alter table public.trips         enable row level security;
alter table public.entries       enable row level security;
alter table public.categories    enable row level security;

drop policy if exists "members read group"  on public.groups;
drop policy if exists "owners rename group" on public.groups;
drop policy if exists "owners delete group" on public.groups;
drop policy if exists "admins rename group" on public.groups;
drop policy if exists "admins delete group" on public.groups;
create policy "members read group"  on public.groups for select to authenticated using (private.is_member(id));
create policy "admins rename group" on public.groups for update to authenticated using (private.is_admin(id)) with check (private.is_admin(id));
create policy "admins delete group" on public.groups for delete to authenticated using (private.is_admin(id));
-- (Groups are created only through create_group().)

-- Access: Administrators see and manage everyone; a User sees only their own row.
drop policy if exists "members see members"    on public.group_members;
drop policy if exists "members add members"    on public.group_members;
drop policy if exists "remove member or leave" on public.group_members;
drop policy if exists "admins and self read"   on public.group_members;
drop policy if exists "admins add"             on public.group_members;
drop policy if exists "admins change role"     on public.group_members;
drop policy if exists "admins remove"          on public.group_members;
create policy "admins and self read" on public.group_members for select to authenticated
  using (private.is_admin(group_id) or email = private.my_email());
create policy "admins add" on public.group_members for insert to authenticated
  with check (private.is_admin(group_id));
create policy "admins change role" on public.group_members for update to authenticated
  using (private.is_admin(group_id)) with check (private.is_admin(group_id));
create policy "admins remove" on public.group_members for delete to authenticated
  using (private.is_admin(group_id));

-- People: everyone in the group reads names (the ledger needs them); Administrators add /
-- edit / delete anyone; a User may only create or edit their own record (matching email).
drop policy if exists "group members only"   on public.parties;
drop policy if exists "members read people"  on public.parties;
drop policy if exists "admins or self add"   on public.parties;
drop policy if exists "admins or self edit"  on public.parties;
drop policy if exists "admins delete people" on public.parties;
create policy "members read people" on public.parties for select to authenticated
  using (private.is_member(group_id));
create policy "admins or self add" on public.parties for insert to authenticated
  with check (private.is_admin(group_id) or (private.is_member(group_id) and lower(coalesce(email, '')) = private.my_email()));
create policy "admins or self edit" on public.parties for update to authenticated
  using (private.is_admin(group_id) or (private.is_member(group_id) and lower(coalesce(email, '')) = private.my_email()))
  with check (private.is_admin(group_id) or (private.is_member(group_id) and lower(coalesce(email, '')) = private.my_email()));
create policy "admins delete people" on public.parties for delete to authenticated
  using (private.is_admin(group_id));

do $$
declare t text;
begin
  foreach t in array array['trips', 'entries', 'categories'] loop
    execute format('drop policy if exists "group members only" on public.%I', t);
    execute format('create policy "group members only" on public.%I for all to authenticated using (private.is_member(group_id)) with check (private.is_member(group_id))', t);
  end loop;
end $$;

-- Nothing is readable without signing in.
revoke all on public.groups, public.group_members, public.parties, public.trips, public.entries, public.categories from anon;

-- ---------- invitations ----------
-- An Administrator sends a personal link (by email or text). Whoever signs in through it joins
-- the group with the role it carries, and is linked to the person's card.
create table if not exists public.invitations (
  token             uuid primary key default gen_random_uuid(),
  group_id          uuid not null references public.groups(id) on delete cascade,
  party_id          uuid references public.parties(id) on delete set null,
  email             text,                              -- where it was sent, if by email (also pre-fills sign-in)
  role              text not null default 'user' check (role in ('admin', 'user')),
  created_by_email  text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '30 days',
  accepted_at       timestamptz,
  accepted_email    text
);
create index if not exists invitations_group_idx on public.invitations (group_id, created_at);
alter table public.invitations enable row level security;
drop policy if exists "admins manage invitations" on public.invitations;
create policy "admins manage invitations" on public.invitations for all to authenticated
  using (private.is_admin(group_id)) with check (private.is_admin(group_id));
revoke all on public.invitations from anon;

-- Before signing in: what the link is for (group, who sent it, who it's for). Nothing else.
create or replace function public.invite_preview(invite uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'group', g.name,
    'from', coalesce((select p.name from public.parties p where p.group_id = i.group_id and lower(coalesce(p.email, '')) = i.created_by_email limit 1), split_part(i.created_by_email, '@', 1)),
    'to', (select p.name from public.parties p where p.id = i.party_id),
    'email', i.email,
    'role', i.role,
    'valid', i.accepted_at is null and i.expires_at > now()
  )
  from public.invitations i join public.groups g on g.id = i.group_id
  where i.token = invite
$$;
revoke all on function public.invite_preview(uuid) from public;
grant execute on function public.invite_preview(uuid) to anon, authenticated;

-- After signing in: join the group, link the person's card to this account, use up the link.
create or replace function public.accept_invite(invite uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invitations;
  me text := private.my_email();
begin
  if auth.uid() is null or me = '' then raise exception 'Sign in first'; end if;
  select * into i from public.invitations where token = invite for update;
  if not found then raise exception 'This invitation link isn’t valid.'; end if;
  if i.accepted_at is not null then
    if i.accepted_email = me then return i.group_id; end if;  -- opened twice by the same person
    raise exception 'This invitation has already been used.';
  end if;
  if i.expires_at <= now() then raise exception 'This invitation has expired. Ask for a new one.'; end if;
  insert into public.group_members (group_id, email, role) values (i.group_id, me, i.role)
  on conflict (group_id, email) do update
    set role = case when excluded.role = 'admin' then 'admin' else public.group_members.role end;
  if i.party_id is not null then
    update public.parties set email = me where id = i.party_id and group_id = i.group_id;
  end if;
  update public.invitations set accepted_at = now(), accepted_email = me where token = invite;
  return i.group_id;
end $$;
revoke all on function public.accept_invite(uuid) from public, anon;
grant execute on function public.accept_invite(uuid) to authenticated;

-- Auth hook "Before User Created": new accounts only for invited people.
-- Allowed when the email already has access to a group, or an unused invitation was sent to
-- that email, or the sign-up came through a valid invitation link (its token in user_metadata.invite).
-- Enable: Dashboard > Authentication > Hooks > Before User Created > Postgres > public.hook_invite_only_signup
create or replace function public.hook_invite_only_signup(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  em text := lower(coalesce(event->'user'->>'email', ''));
  tok text := coalesce(event->'user'->'user_metadata'->>'invite', '');
begin
  if em <> '' and exists (select 1 from public.group_members m where m.email = em) then
    return '{}'::jsonb;
  end if;
  if em <> '' and exists (select 1 from public.invitations i
                          where lower(i.email) = em and i.accepted_at is null and i.expires_at > now()) then
    return '{}'::jsonb;
  end if;
  if tok ~ '^[0-9a-f-]{36}$' and exists (select 1 from public.invitations i
                          where i.token = tok::uuid and i.accepted_at is null and i.expires_at > now()) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Trip Split is invitation-only. Open the link in your invitation to sign in.'));
end $$;
grant execute on function public.hook_invite_only_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_invite_only_signup(jsonb) from authenticated, anon, public;

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
drop function if exists private.is_owner(uuid);
