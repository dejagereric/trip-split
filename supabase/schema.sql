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

-- Anyone who belongs to a group (a User or an Administrator) may create a new group, and becomes
-- its Administrator. People without an invitation can't sign up, so creation stays invitation-only.
create or replace function private.may_create_group() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_email() <> '' and (
    coalesce((select value = 'true'::jsonb from private.settings where key = 'open_group_creation'), false)
    or exists (select 1 from public.group_members m where m.email = private.my_email()))
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
-- How each person likes to be paid back, e.g. {"venmo":"eric-dj","paypal":"ericdj","preferred":"venmo"}.
-- For display and sharing only; Trip Split never moves money.
alter table public.parties add column if not exists payment jsonb not null default '{}'::jsonb;

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

-- Proportional splits. A trip keeps each party's (family's) weights for two bases,
-- e.g. {"people": {"<party id>": 4, ...}, "cabins": {"<party id>": 2, ...}}, and a default split.
alter table public.trips
  add column if not exists weights jsonb not null default '{}'::jsonb,
  add column if not exists default_split text not null default 'equal';
alter table public.trips drop constraint if exists trips_default_split_check;
alter table public.trips add constraint trips_default_split_check check (default_split in ('equal', 'people', 'cabins', 'exact'));
-- The weights actually used for an expense split by people or cabins.
alter table public.entries add column if not exists split_weights jsonb;

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

-- Trips, expenses and categories: see "who may change what" at the end of this file.

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
-- Deleting receipt photos: see "who may change what" at the end of this file.

-- Earlier versions kept the helpers in public; remove them (after the rules above stop using them).
drop function if exists public.is_member_path(text);
drop function if exists public.is_owner(uuid);
drop function if exists public.is_member(uuid);
drop function if exists public.my_email();
drop function if exists private.is_owner(uuid);

-- ---------- who may change what (Nov 2026) ----------
-- Administrators may change anything in their group. A User reads everything in the group,
-- but may change or delete only the expenses, payments, trips, categories and receipt photos
-- they added. The database records who added each one, and nobody can change that afterwards.

alter table public.trips      add column if not exists created_by_email text;
alter table public.categories add column if not exists created_by_email text;
-- Rows from before this existed belong to the group's first Administrator.
update public.trips t set created_by_email = (
  select m.email from public.group_members m where m.group_id = t.group_id and m.role = 'admin' order by m.added_at limit 1)
where t.created_by_email is null;
update public.categories c set created_by_email = (
  select m.email from public.group_members m where m.group_id = c.group_id and m.role = 'admin' order by m.added_at limit 1)
where c.created_by_email is null;

-- The signed-in user is recorded as the creator on insert, and the creator never changes.
-- Maintenance without a signed-in user (SQL editor, service key) keeps what it is given.
create or replace function private.stamp_creator() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.my_email() = '' then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by_email := private.my_email();
  else
    new.created_by_email := old.created_by_email;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['trips', 'entries', 'categories'] loop
    execute format('drop trigger if exists stamp_creator on public.%I', t);
    execute format('create trigger stamp_creator before insert or update on public.%I for each row execute function private.stamp_creator()', t);
  end loop;
end $$;

-- Administrators, or the member who added the row.
create or replace function private.can_change(g uuid, creator text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin(g)
      or (private.my_email() <> '' and lower(coalesce(creator, '')) = private.my_email() and private.is_member(g))
$$;

-- An entry's trip must be in the entry's own group.
create or replace function private.trip_in_group(trip uuid, g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trips t where t.id = trip and t.group_id = g)
$$;

-- Deleting a trip deletes its expenses, so a User may delete their own trip only when
-- every expense in it is theirs too.
create or replace function private.trip_only_mine(trip uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.entries e
                     where e.trip_id = trip and lower(coalesce(e.created_by_email, '')) <> private.my_email())
$$;

create or replace function private.is_admin_path(folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select folder ~ '^[0-9a-f-]{36}$' and private.is_admin(folder::uuid)
$$;

-- A receipt photo attached to an expense the signed-in user added.
create or replace function private.receipt_is_mine(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_email() <> '' and exists (
    select 1 from public.entries e
    where e.receipt_path = path and lower(coalesce(e.created_by_email, '')) = private.my_email())
$$;

-- Renaming a category relabels the expenses that use it, including other people's.
create or replace function private.rename_category_in_entries() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.name is distinct from old.name then
    update public.entries set category = new.name where group_id = new.group_id and category = old.name;
  end if;
  return null;
end $$;
drop trigger if exists rename_category_in_entries on public.categories;
create trigger rename_category_in_entries after update of name on public.categories
  for each row execute function private.rename_category_in_entries();

revoke all on function private.stamp_creator(), private.can_change(uuid, text), private.trip_in_group(uuid, uuid),
  private.trip_only_mine(uuid), private.is_admin_path(text), private.receipt_is_mine(text),
  private.rename_category_in_entries() from public, anon;
grant execute on function private.can_change(uuid, text), private.trip_in_group(uuid, uuid),
  private.trip_only_mine(uuid), private.is_admin_path(text), private.receipt_is_mine(text) to authenticated;

-- Logging an expense on someone else's trip may add people and currencies to that trip's
-- lists (never remove or change anything), so a User can include someone new.
create or replace function public.add_to_trip(trip uuid, people uuid[] default '{}', add_currencies text[] default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
begin
  select * into t from public.trips where id = trip for update;
  if not found or not private.is_member(t.group_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update public.trips set
    member_ids = member_ids || coalesce((
      select jsonb_agg(p.id) from public.parties p
      where p.group_id = t.group_id and p.id = any(people) and not (t.member_ids ? p.id::text)), '[]'::jsonb),
    currencies = currencies || coalesce((
      select jsonb_agg(distinct c) from unnest(add_currencies) c
      where c ~ '^[A-Z]{3}$' and not (t.currencies ? c)), '[]'::jsonb)
  where id = trip;
end $$;
revoke all on function public.add_to_trip(uuid, uuid[], text[]) from public, anon;
grant execute on function public.add_to_trip(uuid, uuid[], text[]) to authenticated;

-- Expenses and payments.
drop policy if exists "group members only"              on public.entries;
drop policy if exists "members read entries"            on public.entries;
drop policy if exists "members add entries"             on public.entries;
drop policy if exists "admins or creator edit entries"   on public.entries;
drop policy if exists "admins or creator delete entries" on public.entries;
create policy "members read entries" on public.entries for select to authenticated
  using (private.is_member(group_id));
create policy "members add entries" on public.entries for insert to authenticated
  with check (private.can_change(group_id, created_by_email) and private.trip_in_group(trip_id, group_id));
create policy "admins or creator edit entries" on public.entries for update to authenticated
  using (private.can_change(group_id, created_by_email))
  with check (private.can_change(group_id, created_by_email) and private.trip_in_group(trip_id, group_id));
create policy "admins or creator delete entries" on public.entries for delete to authenticated
  using (private.can_change(group_id, created_by_email));

-- Trips.
drop policy if exists "group members only"             on public.trips;
drop policy if exists "members read trips"             on public.trips;
drop policy if exists "members add trips"              on public.trips;
drop policy if exists "admins or creator edit trips"   on public.trips;
drop policy if exists "admins or creator delete trips" on public.trips;
create policy "members read trips" on public.trips for select to authenticated
  using (private.is_member(group_id));
create policy "members add trips" on public.trips for insert to authenticated
  with check (private.can_change(group_id, created_by_email));
create policy "admins or creator edit trips" on public.trips for update to authenticated
  using (private.can_change(group_id, created_by_email)) with check (private.can_change(group_id, created_by_email));
create policy "admins or creator delete trips" on public.trips for delete to authenticated
  using (private.is_admin(group_id) or (private.can_change(group_id, created_by_email) and private.trip_only_mine(id)));

-- Categories.
drop policy if exists "group members only"                  on public.categories;
drop policy if exists "members read categories"             on public.categories;
drop policy if exists "members add categories"              on public.categories;
drop policy if exists "admins or creator edit categories"   on public.categories;
drop policy if exists "admins or creator delete categories" on public.categories;
create policy "members read categories" on public.categories for select to authenticated
  using (private.is_member(group_id));
create policy "members add categories" on public.categories for insert to authenticated
  with check (private.can_change(group_id, created_by_email));
create policy "admins or creator edit categories" on public.categories for update to authenticated
  using (private.can_change(group_id, created_by_email)) with check (private.can_change(group_id, created_by_email));
create policy "admins or creator delete categories" on public.categories for delete to authenticated
  using (private.can_change(group_id, created_by_email));

-- Receipt photos: anyone in the group views and uploads; Administrators delete any, a User
-- deletes only photos they uploaded or that belong to an expense they added.
drop policy if exists "members delete receipts"            on storage.objects;
drop policy if exists "admins or uploader delete receipts" on storage.objects;
create policy "admins or uploader delete receipts" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts'
         and private.is_member_path((storage.foldername(name))[1])
         and (private.is_admin_path((storage.foldername(name))[1])
              or owner_id = (select auth.uid())::text
              or private.receipt_is_mine(name)));

-- ---------- inactive trips and safer trip deletion (Nov 2026) ----------
-- A trip's owner or an Administrator can mark it inactive: it's hidden from the trip lists and
-- its expenses and payments are read-only until it's made active again. Deleting a trip never
-- destroys other people's records: delete_trip() moves each person's entries to a default trip
-- they own (one per currency), and only the deleting person's own entries are deleted.

alter table public.trips
  add column if not exists inactive_at timestamptz,
  add column if not exists inactive_by text,
  add column if not exists default_for_email text;   -- set only on a person's default trip
create unique index if not exists trips_one_default_per_currency
  on public.trips (group_id, default_for_email, currency) where default_for_email is not null;
-- Where a moved entry came from, e.g. "Lisbon · deleted by Frank Forte · 2026-11-21".
alter table public.entries add column if not exists moved_from text;

-- Who added a row, a default trip's owner and a moved entry's origin are set by the database
-- and never change afterwards. delete_trip() sets tripsplit.keep_creator for its own
-- transaction so it can create a default trip owned by someone else; the API can't set it.
create or replace function private.stamp_creator() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.my_email() = '' or current_setting('tripsplit.keep_creator', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by_email := private.my_email();
    if tg_table_name = 'trips' then new.default_for_email := null; end if;
    if tg_table_name = 'entries' then new.moved_from := null; end if;
  else
    new.created_by_email := old.created_by_email;
    if tg_table_name = 'trips' then new.default_for_email := old.default_for_email; end if;
    if tg_table_name = 'entries' then new.moved_from := old.moved_from; end if;
  end if;
  return new;
end $$;

-- Records who made a trip inactive (and when), and clears it when it's made active again.
create or replace function private.trip_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.inactive_at is null then new.inactive_by := null; else new.inactive_by := nullif(private.my_email(), ''); end if;
  elsif new.inactive_at is distinct from old.inactive_at then
    if new.inactive_at is null then
      new.inactive_by := null;
    else
      new.inactive_at := now();
      new.inactive_by := nullif(private.my_email(), '');
    end if;
  else
    new.inactive_by := old.inactive_by;
  end if;
  return new;
end $$;
drop trigger if exists trip_state on public.trips;
create trigger trip_state before insert or update on public.trips
  for each row execute function private.trip_state();

create or replace function private.trip_is_active(trip uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trips t where t.id = trip and t.inactive_at is null)
$$;

revoke all on function private.stamp_creator(), private.trip_state(), private.trip_is_active(uuid) from public, anon;
grant execute on function private.trip_is_active(uuid) to authenticated;

-- An inactive trip's expenses and payments are read-only.
drop policy if exists "members add entries"              on public.entries;
drop policy if exists "admins or creator edit entries"   on public.entries;
drop policy if exists "admins or creator delete entries" on public.entries;
create policy "members add entries" on public.entries for insert to authenticated
  with check (private.can_change(group_id, created_by_email) and private.trip_in_group(trip_id, group_id)
              and private.trip_is_active(trip_id));
create policy "admins or creator edit entries" on public.entries for update to authenticated
  using (private.can_change(group_id, created_by_email) and private.trip_is_active(trip_id))
  with check (private.can_change(group_id, created_by_email) and private.trip_in_group(trip_id, group_id)
              and private.trip_is_active(trip_id));
create policy "admins or creator delete entries" on public.entries for delete to authenticated
  using (private.can_change(group_id, created_by_email) and private.trip_is_active(trip_id));

-- A direct delete only works when every entry in the trip is the caller's, for Administrators
-- too; anything else goes through delete_trip(), so nobody can wipe other people's records.
drop policy if exists "admins or creator delete trips" on public.trips;
create policy "admins or creator delete trips" on public.trips for delete to authenticated
  using (private.can_change(group_id, created_by_email) and private.trip_only_mine(id));

-- Logging an expense can't add people or currencies to an inactive trip.
create or replace function public.add_to_trip(trip uuid, people uuid[] default '{}', add_currencies text[] default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
begin
  select * into t from public.trips where id = trip for update;
  if not found or not private.is_member(t.group_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if t.inactive_at is not null then
    raise exception 'trip_inactive' using errcode = '42501';
  end if;
  update public.trips set
    member_ids = member_ids || coalesce((
      select jsonb_agg(p.id) from public.parties p
      where p.group_id = t.group_id and p.id = any(people) and not (t.member_ids ? p.id::text)), '[]'::jsonb),
    currencies = currencies || coalesce((
      select jsonb_agg(distinct c) from unnest(add_currencies) c
      where c ~ '^[A-Z]{3}$' and not (t.currencies ? c)), '[]'::jsonb)
  where id = trip;
end $$;
revoke all on function public.add_to_trip(uuid, uuid[], text[]) from public, anon;
grant execute on function public.add_to_trip(uuid, uuid[], text[]) to authenticated;

-- Deletes a trip (its owner or an Administrator). Each other person's entries move, unchanged,
-- to that person's default trip for the trip's currency (created if needed, owned by them, with
-- only them on its people list); the caller's own entries are deleted with the trip.
-- Returns {"deleted": n, "moved": [{"email", "name", "trip_id", "trip_name", "count"}, ...]}.
create or replace function public.delete_trip(trip uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  me text := private.my_email();
  who record;
  dest uuid;
  dest_name text;
  person text;
  base text;
  i int;
  moved jsonb := '[]'::jsonb;
  deleted int;
  origin text;
begin
  select * into t from public.trips where id = trip for update;
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0002';
  end if;
  if me = '' or not private.can_change(t.group_id, t.created_by_email) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  perform set_config('tripsplit.keep_creator', 'on', true);

  -- A default trip being deleted stops being one, so its owner gets a fresh default trip.
  update public.trips set default_for_email = null where id = t.id and default_for_email is not null;

  origin := t.name || ' · deleted by '
    || coalesce((select p.name from public.parties p where p.group_id = t.group_id and lower(p.email) = me limit 1), me)
    || ' · ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');

  for who in
    select x.email, count(*) as n from (
      select lower(coalesce(nullif(e.created_by_email, ''), t.created_by_email, '')) as email
      from public.entries e where e.trip_id = t.id) x
    where x.email not in (me, '')
    group by x.email order by x.email
  loop
    person := coalesce(
      (select split_part(trim(p.name), ' ', 1) from public.parties p
        where p.group_id = t.group_id and lower(p.email) = who.email and trim(p.name) <> '' limit 1),
      split_part(who.email, '@', 1));
    select d.id, d.name into dest, dest_name from public.trips d
      where d.group_id = t.group_id and d.default_for_email = who.email and d.currency = t.currency and d.id <> t.id;
    if dest is null then
      base := person || '''s expenses'
        || case when exists (select 1 from public.trips d where d.group_id = t.group_id and d.default_for_email = who.email)
                then ' (' || t.currency || ')' else '' end;
      dest_name := base; i := 1;
      while exists (select 1 from public.trips d where d.group_id = t.group_id and d.name = dest_name and d.id <> t.id) loop
        i := i + 1; dest_name := base || ' ' || i;
      end loop;
      dest := gen_random_uuid();
      insert into public.trips (id, group_id, name, currency, currencies, member_ids, created_by_email, default_for_email)
      values (dest, t.group_id, dest_name, t.currency, jsonb_build_array(t.currency),
              coalesce((select jsonb_build_array(p.id) from public.parties p
                        where p.group_id = t.group_id and lower(p.email) = who.email limit 1), '[]'::jsonb),
              who.email, who.email);
    else
      update public.trips set inactive_at = null where id = dest and inactive_at is not null;
    end if;
    update public.entries set trip_id = dest, moved_from = origin
      where trip_id = t.id and lower(coalesce(nullif(created_by_email, ''), t.created_by_email, '')) = who.email;
    moved := moved || jsonb_build_object('email', who.email, 'name', person, 'trip_id', dest, 'trip_name', dest_name, 'count', who.n);
    dest := null; person := null;
  end loop;

  select count(*) into deleted from public.entries where trip_id = t.id;
  delete from public.trips where id = t.id;   -- its remaining (the caller's own) entries go with it
  perform set_config('tripsplit.keep_creator', '', true);
  return jsonb_build_object('deleted', deleted, 'moved', moved);
end $$;
revoke all on function public.delete_trip(uuid) from public, anon;
grant execute on function public.delete_trip(uuid) to authenticated;
