-- Test for inactive trips and delete_trip() in schema.sql. Run it in the SQL editor right after
-- schema.sql, in the same run (paste both). It always ends with an error so that everything is
-- rolled back; the error message is the test report. Every line should end in "ok".
do $$
declare
  g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
  id_a uuid := gen_random_uuid(); id_u1 uuid := gen_random_uuid(); id_u2 uuid := gen_random_uuid(); id_o uuid := gen_random_uuid();
  pa uuid := gen_random_uuid(); pu1 uuid := gen_random_uuid(); pu2 uuid := gen_random_uuid(); pu3 uuid := gen_random_uuid();
  tl uuid := gen_random_uuid(); te uuid := gen_random_uuid(); tda uuid := gen_random_uuid(); tclash uuid := gen_random_uuid();
  l1 uuid := gen_random_uuid(); l2 uuid := gen_random_uuid(); l3 uuid := gen_random_uuid(); l4 uuid := gen_random_uuid();
  l5 uuid := gen_random_uuid(); l6 uuid := gen_random_uuid(); e1 uuid := gen_random_uuid(); tnew uuid := gen_random_uuid();
  em_a text := 'ann.life@example.com'; em_u1 text := 'frank.life@example.com'; em_u2 text := 'eric.life@example.com';
  em_u3 text := 'gone.life@example.com'; em_o text := 'out.life@example.com';
  r text := ''; n int; v text; ok boolean; res jsonb; d2 uuid; d3 uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.groups (id, name) values (g, 'life test'), (g2, 'other group');
  insert into public.group_members (group_id, email, role) values
    (g, em_a, 'admin'), (g, em_u1, 'user'), (g, em_u2, 'user'), (g2, em_o, 'admin');
  insert into public.parties (id, group_id, name, email) values
    (pa, g, 'Ann Admin', em_a), (pu1, g, 'Frank Forte', em_u1), (pu2, g, 'Eric de Jager', em_u2), (pu3, g, 'Gone Person', em_u3);
  insert into public.trips (id, group_id, name, currency, currencies, created_by_email) values
    (tl, g, 'Lisbon', 'USD', '["USD"]', em_u1), (te, g, 'Elba', 'EUR', '["EUR"]', em_u1),
    (tclash, g, 'Gone''s expenses', 'USD', '["USD"]', em_a);
  insert into public.trips (id, group_id, name, currency, currencies, created_by_email, default_for_email, inactive_at) values
    (tda, g, 'Ann''s expenses', 'USD', '["USD"]', em_a, em_a, now());
  insert into public.entries (id, group_id, trip_id, kind, amount_cents, description, created_by_email) values
    (l1, g, tl, 'expense', 100, 'frank 1', em_u1), (l2, g, tl, 'expense', 200, 'frank 2', em_u1),
    (l3, g, tl, 'expense', 300, 'eric dinner', em_u2), (l4, g, tl, 'payment', 400, null, em_u2),
    (l5, g, tl, 'expense', 500, 'ann taxi', em_a), (l6, g, tl, 'expense', 600, 'gone lunch', em_u3),
    (e1, g, te, 'expense', 700, 'eric elba', em_u2);
  select inactive_by into v from public.trips where id = tda;
  r := r || E'\nsetup: default trip starts inactive: ' || case when v is null and (select inactive_at is not null from public.trips where id = tda) then 'ok' else 'FAIL' end;

  -- ---- Eric (User, not the owner of Lisbon) ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u2, 'email', em_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_trip(tl);
    r := r || E'\nUser who doesn''t own the trip: delete_trip refused: FAIL';
  exception when insufficient_privilege then r := r || E'\nUser who doesn''t own the trip: delete_trip refused: ok'; end;
  delete from public.trips where id = tl; get diagnostics n = row_count;
  r := r || E'\nUser who doesn''t own the trip: direct delete refused: ' || case when n = 0 then 'ok' else 'FAIL' end;
  reset role;

  -- ---- Frank (User, owns Lisbon and Elba) ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u1, 'email', em_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.trips where id = tl; get diagnostics n = row_count;
  r := r || E'\nOwner: direct delete of a trip with others'' entries refused: ' || case when n = 0 then 'ok' else 'FAIL' end;
  update public.trips set inactive_at = now() where id = te; get diagnostics n = row_count;
  reset role;
  select inactive_by into v from public.trips where id = te;
  r := r || E'\nOwner: mark trip inactive, recorded who: ' || case when n = 1 and v = em_u1 then 'ok' else 'FAIL ' || n || ' ' || coalesce(v, 'null') end;

  -- ---- Eric on the inactive trip ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u2, 'email', em_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.entries (id, group_id, trip_id, kind, amount_cents) values (gen_random_uuid(), g, te, 'expense', 1);
    r := r || E'\nInactive trip: new expense refused: FAIL';
  exception when insufficient_privilege then r := r || E'\nInactive trip: new expense refused: ok'; end;
  update public.entries set description = 'edited' where id = e1; get diagnostics n = row_count;
  r := r || E'\nInactive trip: editing own expense refused: ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.entries where id = e1; get diagnostics n = row_count;
  r := r || E'\nInactive trip: deleting own expense refused: ' || case when n = 0 then 'ok' else 'FAIL' end;
  begin
    perform public.add_to_trip(te, array[pu2], '{}');
    r := r || E'\nInactive trip: add_to_trip refused: FAIL';
  exception when insufficient_privilege then r := r || E'\nInactive trip: add_to_trip refused: ok'; end;
  update public.trips set inactive_at = null where id = te; get diagnostics n = row_count;
  r := r || E'\nInactive trip: non-owner can''t make it active: ' || case when n = 0 then 'ok' else 'FAIL' end;
  insert into public.trips (id, group_id, name, created_by_email, default_for_email) values (tnew, g, 'Sneaky', em_u2, em_a);
  select coalesce(default_for_email, 'null') into v from public.trips where id = tnew;
  r := r || E'\nUser can''t create a trip marked as someone''s default trip: ' || case when v = 'null' then 'ok' else 'FAIL ' || v end;
  reset role;

  -- ---- Frank makes Elba active again ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u1, 'email', em_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.trips set inactive_at = null where id = te; get diagnostics n = row_count;
  reset role;
  select coalesce(inactive_by, 'null') into v from public.trips where id = te;
  r := r || E'\nOwner: make trip active again, clears who: ' || case when n = 1 and v = 'null' then 'ok' else 'FAIL' end;

  -- ---- Ann (Administrator): direct delete is refused too ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_a, 'email', em_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.trips where id = tl; get diagnostics n = row_count;
  r := r || E'\nAdministrator: direct delete of a trip with others'' entries refused: ' || case when n = 0 then 'ok' else 'FAIL' end;
  reset role;

  -- ---- Frank deletes Lisbon ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u1, 'email', em_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.delete_trip(tl);
  reset role;
  r := r || E'\ndelete_trip: own 2 entries deleted, 3 people''s entries moved: '
    || case when (res->>'deleted')::int = 2 and jsonb_array_length(res->'moved') = 3 then 'ok' else 'FAIL ' || res::text end;
  r := r || E'\ndelete_trip: trip and owner''s entries gone: '
    || case when not exists (select 1 from public.trips where id = tl) and not exists (select 1 from public.entries where id in (l1, l2)) then 'ok' else 'FAIL' end;
  select trip_id into d2 from public.entries where id = l3;
  ok := (select t.default_for_email = em_u2 and t.created_by_email = em_u2 and t.currency = 'USD' and t.name = 'Eric''s expenses'
            and t.member_ids = jsonb_build_array(pu2) from public.trips t where t.id = d2)
        and (select trip_id = d2 from public.entries where id = l4)
        and (select created_by_email = em_u2 and amount_cents = 300 and moved_from like 'Lisbon · deleted by Frank Forte · %' from public.entries where id = l3);
  r := r || E'\ndelete_trip: Eric''s expense and payment moved, unchanged, to a new default trip he owns: ' || case when ok then 'ok' else 'FAIL' end;
  ok := (select trip_id = tda from public.entries where id = l5) and (select inactive_at is null from public.trips where id = tda);
  r := r || E'\ndelete_trip: Ann''s entry reuses her inactive default trip and makes it active: ' || case when ok then 'ok' else 'FAIL' end;
  select trip_id into d3 from public.entries where id = l6;
  select name into v from public.trips where id = d3;
  ok := (select default_for_email = em_u3 and created_by_email = em_u3 from public.trips where id = d3);
  r := r || E'\ndelete_trip: departed member''s entry gets a default trip in their name, clashing name numbered: ' || case when ok and v = 'Gone''s expenses 2' then 'ok' else 'FAIL ' || coalesce(v, 'null') end;

  perform set_config('request.jwt.claims', json_build_object('sub', id_u1, 'email', em_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.delete_trip(te);
  reset role;
  select name into v from public.trips t where t.id = (select trip_id from public.entries where id = e1);
  ok := (select t.default_for_email = em_u2 and t.currency = 'EUR' from public.trips t where t.id = (select trip_id from public.entries where id = e1));
  r := r || E'\ndelete_trip: EUR entry gets a separate EUR default trip: ' || case when ok and v = 'Eric''s expenses (EUR)' then 'ok' else 'FAIL ' || coalesce(v, 'null') end;

  -- ---- Eric can't rewrite where an entry came from, or un-default his trip ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u2, 'email', em_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.entries set description = 'eric dinner!', moved_from = 'nowhere' where id = l3; get diagnostics n = row_count;
  update public.trips set default_for_email = null, name = 'My stuff' where id = d2;
  reset role;
  ok := n = 1 and (select moved_from like 'Lisbon%' and description = 'eric dinner!' from public.entries where id = l3)
        and (select default_for_email = em_u2 and name = 'My stuff' from public.trips where id = d2);
  r := r || E'\nOwner of moved entries edits them and renames the trip, origin and default mark kept: ' || case when ok then 'ok' else 'FAIL' end;

  -- ---- Ann (Administrator) deletes Eric's USD default trip: his entries move to a fresh one ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_a, 'email', em_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.delete_trip(d2);
  reset role;
  select name into v from public.trips t where t.id = (select trip_id from public.entries where id = l3);
  ok := (select trip_id <> d2 from public.entries where id = l3)
        and (select t.default_for_email = em_u2 and t.currency = 'USD' from public.trips t where t.id = (select trip_id from public.entries where id = l3))
        and not exists (select 1 from public.trips where id = d2);
  r := r || E'\nAdministrator deletes someone''s default trip: entries move to a fresh default trip: ' || case when ok and v = 'Eric''s expenses (USD)' then 'ok' else 'FAIL ' || coalesce(v, 'null') end;

  -- ---- Outsider ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_o, 'email', em_o, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_trip(tda);
    r := r || E'\nOutsider: delete_trip refused: FAIL';
  exception when insufficient_privilege then r := r || E'\nOutsider: delete_trip refused: ok'; end;
  reset role;

  -- ---- Eric deletes his own default trip (only his entries): nothing to move ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u2, 'email', em_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.delete_trip((select trip_id from public.entries where id = l3));
  reset role;
  r := r || E'\nUser deletes own trip with only own entries: deleted, nothing moved: '
    || case when (res->>'deleted')::int = 2 and jsonb_array_length(res->'moved') = 0 and not exists (select 1 from public.entries where id = l3) then 'ok' else 'FAIL ' || res::text end;

  raise exception 'TRIP LIFECYCLE TEST REPORT (rolled back):%', r;
end $$;
