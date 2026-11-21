-- Test for the "who may change what" rules in schema.sql. Run it in the SQL editor right after
-- schema.sql, in the same run (paste both).
-- It always ends with an error so that everything (including the rules) is rolled back;
-- the error message is the test report. Every line should end in "ok".
do $$
declare
  g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
  id_ua uuid := gen_random_uuid(); id_u1 uuid := gen_random_uuid(); id_u2 uuid := gen_random_uuid(); id_uo uuid := gen_random_uuid();
  pa uuid := gen_random_uuid(); pu1 uuid := gen_random_uuid(); pu2 uuid := gen_random_uuid(); px uuid := gen_random_uuid();
  ta uuid := gen_random_uuid(); tu1 uuid := gen_random_uuid(); tu1b uuid := gen_random_uuid(); tx uuid := gen_random_uuid();
  ea uuid := gen_random_uuid(); eu1 uuid := gen_random_uuid(); eu2 uuid := gen_random_uuid(); eu1b uuid := gen_random_uuid();
  enew uuid := gen_random_uuid(); tnew uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); cu1 uuid := gen_random_uuid(); cnew uuid := gen_random_uuid();
  A text := 'admin.rbac@example.com'; U1 text := 'user1.rbac@example.com'; U2 text := 'user2.rbac@example.com'; O text := 'outsider.rbac@example.com';
  r text := ''; n int; v text; ok boolean;
begin
  -- ---- setup, as the database owner with nobody signed in ----
  perform set_config('request.jwt.claims', '', true);
  insert into public.groups (id, name) values (g, 'rbac test'), (g2, 'other group');
  insert into public.group_members (group_id, email, role) values (g, A, 'admin'), (g, U1, 'user'), (g, U2, 'user'), (g2, O, 'admin');
  insert into public.parties (id, group_id, name, email) values
    (pa, g, 'Admin', A), (pu1, g, 'User One', U1), (pu2, g, 'User Two', U2), (px, g2, 'Outsider', O);
  insert into public.trips (id, group_id, name, member_ids, currencies, created_by_email) values
    (ta, g, 'Admin trip', jsonb_build_array(pa), '["USD"]', A),
    (tu1, g, 'User1 trip', '[]', '["USD"]', U1),
    (tu1b, g, 'User1 solo trip', '[]', '["USD"]', U1),
    (tx, g2, 'Other group trip', '[]', '["USD"]', O);
  insert into public.categories (id, group_id, name, created_by_email) values (ca, g, 'Food rbac', A), (cu1, g, 'Snacks rbac', U1);
  insert into public.entries (id, group_id, trip_id, kind, amount_cents, category, description, receipt_path, created_by_email) values
    (ea,   g, ta,   'expense', 1000, 'Snacks rbac', 'admin dinner', g || '/admin.jpg', A),
    (eu1,  g, ta,   'expense', 2000, 'Food rbac',   'user1 taxi',   null, U1),
    (eu2,  g, tu1,  'expense', 3000, 'Food rbac',   'user2 lunch',  g || '/other-upload.jpg', U2),
    (eu1b, g, tu1b, 'expense', 4000, 'Food rbac',   'user1 solo',   null, U1);
  select created_by_email into v from public.entries where id = ea;
  r := r || E'\nsetup keeps given creator with nobody signed in: ' || case when v = A then 'ok' else 'FAIL ' || v end;

  -- ---- User Two ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u2, 'email', U2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.entries where group_id = g;
  r := r || E'\nU2 reads all 4 expenses: ' || case when n = 4 then 'ok' else 'FAIL ' || n end;
  select count(*) into n from public.trips where group_id = g;
  r := r || E'\nU2 reads all 3 trips: ' || case when n = 3 then 'ok' else 'FAIL ' || n end;
  update public.entries set description = 'hacked' where id = ea; get diagnostics n = row_count;
  r := r || E'\nU2 edit Admin''s expense blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  begin
    insert into public.entries (id, group_id, trip_id, kind, amount_cents) values (ea, g, ta, 'expense', 1)
      on conflict (id) do update set amount_cents = excluded.amount_cents;
    r := r || E'\nU2 upsert over Admin''s expense blocked: FAIL';
  exception when insufficient_privilege then r := r || E'\nU2 upsert over Admin''s expense blocked: ok'; end;
  delete from public.entries where id = eu1; get diagnostics n = row_count;
  r := r || E'\nU2 delete User One''s expense blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  insert into public.entries (id, group_id, trip_id, kind, amount_cents, created_by_email) values (enew, g, ta, 'expense', 500, A);
  select created_by_email into v from public.entries where id = enew;
  r := r || E'\nU2 add expense on Admin''s trip, faked creator replaced: ' || case when v = U2 then 'ok' else 'FAIL ' || v end;
  update public.entries set description = 'mine', created_by_email = A where id = eu2; get diagnostics n = row_count;
  select created_by_email into v from public.entries where id = eu2;
  r := r || E'\nU2 edit own expense, creator unchanged: ' || case when n = 1 and v = U2 then 'ok' else 'FAIL ' || n || ' ' || v end;
  delete from public.entries where id = enew; get diagnostics n = row_count;
  r := r || E'\nU2 delete own expense: ' || case when n = 1 then 'ok' else 'FAIL' end;
  begin
    insert into public.entries (id, group_id, trip_id, kind, amount_cents) values (gen_random_uuid(), g, tx, 'expense', 1);
    r := r || E'\nU2 expense on another group''s trip blocked: FAIL';
  exception when insufficient_privilege then r := r || E'\nU2 expense on another group''s trip blocked: ok'; end;
  update public.trips set name = 'hacked' where id = ta; get diagnostics n = row_count;
  r := r || E'\nU2 edit Admin''s trip blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.trips where id = tu1b; get diagnostics n = row_count;
  r := r || E'\nU2 delete User One''s trip blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  perform public.add_to_trip(ta, array[pu2, px], array['GBP', 'bad', 'usd', 'USD']);
  reset role;
  select member_ids::text || ' ' || currencies::text into v from public.trips where id = ta;
  ok := (select member_ids ? pu2::text and not member_ids ? px::text and member_ids ? pa::text and currencies = '["USD", "GBP"]'::jsonb from public.trips where id = ta);
  r := r || E'\nU2 add_to_trip only appends this group''s people and valid currencies: ' || case when ok then 'ok' else 'FAIL ' || v end;
  set local role authenticated;
  insert into public.trips (id, group_id, name, created_by_email) values (tnew, g, 'U2 trip', A);
  select created_by_email into v from public.trips where id = tnew;
  r := r || E'\nU2 create trip, faked creator replaced: ' || case when v = U2 then 'ok' else 'FAIL ' || v end;
  update public.categories set name = 'hacked' where id = ca; get diagnostics n = row_count;
  r := r || E'\nU2 rename Admin''s category blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.categories where id = cu1; get diagnostics n = row_count;
  r := r || E'\nU2 delete User One''s category blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  insert into public.categories (id, group_id, name) values (cnew, g, 'U2 cat');
  update public.categories set name = 'U2 cat renamed' where id = cnew; get diagnostics n = row_count;
  r := r || E'\nU2 add and rename own category: ' || case when n = 1 then 'ok' else 'FAIL' end;
  -- receipt delete rule: (is the photo uploaded by me) or (attached to my expense) or (I'm an Administrator)
  ok := private.is_admin_path(g::text) or id_ua::text = (select auth.uid())::text or private.receipt_is_mine(g || '/admin.jpg');
  r := r || E'\nU2 delete Admin''s receipt photo blocked: ' || case when not ok then 'ok' else 'FAIL' end;
  ok := id_u2::text = (select auth.uid())::text;
  r := r || E'\nU2 delete a photo U2 uploaded allowed: ' || case when ok then 'ok' else 'FAIL' end;
  ok := private.receipt_is_mine(g || '/other-upload.jpg');
  r := r || E'\nU2 delete photo on own expense allowed: ' || case when ok then 'ok' else 'FAIL' end;
  reset role;

  -- ---- User One ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_u1, 'email', U1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.trips where id = tu1; get diagnostics n = row_count;
  r := r || E'\nU1 delete own trip holding User Two''s expense blocked: ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.trips where id = tu1b; get diagnostics n = row_count;
  r := r || E'\nU1 delete own trip with only own expenses: ' || case when n = 1 then 'ok' else 'FAIL' end;
  update public.categories set name = 'Treats rbac' where id = cu1; get diagnostics n = row_count;
  reset role;
  select category || ' / ' || created_by_email into v from public.entries where id = ea;
  r := r || E'\nU1 rename own category relabels Admin''s expense, creator kept: ' || case when n = 1 and v = 'Treats rbac / ' || A then 'ok' else 'FAIL ' || v end;

  -- ---- Administrator ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_ua, 'email', A, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.entries set description = 'fixed by admin' where id = eu1; get diagnostics n = row_count;
  select created_by_email into v from public.entries where id = eu1;
  r := r || E'\nAdmin edit User One''s expense, creator kept: ' || case when n = 1 and v = U1 then 'ok' else 'FAIL ' || n || ' ' || v end;
  update public.trips set name = 'renamed by admin' where id = tnew; get diagnostics n = row_count;
  r := r || E'\nAdmin edit User Two''s trip: ' || case when n = 1 then 'ok' else 'FAIL' end;
  delete from public.trips where id = tu1; get diagnostics n = row_count;
  r := r || E'\nAdmin direct delete of trip holding others'' expenses refused (delete_trip moves them instead): ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.categories where id = cnew; get diagnostics n = row_count;
  r := r || E'\nAdmin delete User Two''s category: ' || case when n = 1 then 'ok' else 'FAIL' end;
  ok := private.is_admin_path(g::text);
  r := r || E'\nAdmin delete any receipt photo allowed: ' || case when ok then 'ok' else 'FAIL' end;
  reset role;

  -- ---- Outsider (Administrator of another group) ----
  perform set_config('request.jwt.claims', json_build_object('sub', id_uo, 'email', O, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.entries where group_id = g;
  r := r || E'\nOutsider reads nothing: ' || case when n = 0 then 'ok' else 'FAIL ' || n end;
  begin
    perform public.add_to_trip(ta, array[px], '{}');
    r := r || E'\nOutsider add_to_trip blocked: FAIL';
  exception when insufficient_privilege then r := r || E'\nOutsider add_to_trip blocked: ok'; end;
  ok := private.is_member_path(g::text);
  r := r || E'\nOutsider receipt photos blocked: ' || case when not ok then 'ok' else 'FAIL' end;
  reset role;

  raise exception 'RBAC TEST REPORT (rolled back):%', r;
end $$;
