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
