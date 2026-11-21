-- Test for who may create a group (schema.sql: private.may_create_group). Run it in the SQL editor;
-- it always ends with an error so that everything is rolled back, and the message is the report.
-- create_group records the creator's sign-in id, so the pretend User borrows a real one.
do $$
declare
  g uuid := gen_random_uuid(); id_u uuid := (select id from auth.users order by created_at limit 1); id_n uuid := gen_random_uuid(); id_a uuid := gen_random_uuid();
  em_u text := 'user.grp@example.com'; em_n text := 'nobody.grp@example.com'; em_a text := 'admin.grp@example.com';
  r text := ''; ng uuid; n int; v text; ok boolean;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.groups (id, name) values (g, 'grp test');
  insert into public.group_members (group_id, email, role) values (g, em_a, 'admin'), (g, em_u, 'user');

  perform set_config('request.jwt.claims', json_build_object('sub', id_u, 'email', em_u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := public.can_create_group();
  r := r || E'\nUser: can_create_group says yes: ' || case when ok then 'ok' else 'FAIL' end;
  ng := public.create_group('Frank family');
  select role into v from public.group_members where group_id = ng and email = em_u;
  r := r || E'\nUser creates a group and is its Administrator: ' || case when v = 'admin' then 'ok' else 'FAIL ' || coalesce(v, 'null') end;
  select count(*) into n from public.categories where group_id = ng;
  r := r || E'\nNew group starts with the default categories: ' || case when n = 8 then 'ok' else 'FAIL ' || n end;
  insert into public.group_members (group_id, email, role) values (ng, em_a, 'user');
  update public.groups set name = 'Forte family' where id = ng; get diagnostics n = row_count;
  r := r || E'\nCreator adds a member and renames the group: ' || case when n = 1 then 'ok' else 'FAIL' end;
  update public.groups set name = 'hacked' where id = g; get diagnostics n = row_count;
  r := r || E'\nUser still can''t rename the group where they are a User: ' || case when n = 0 then 'ok' else 'FAIL' end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', id_a, 'email', em_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.groups where id = ng;
  r := r || E'\nMember added as a User reads the new group: ' || case when n = 1 then 'ok' else 'FAIL' end;
  update public.groups set name = 'hacked' where id = ng; get diagnostics n = row_count;
  r := r || E'\n...but can''t rename it: ' || case when n = 0 then 'ok' else 'FAIL' end;
  delete from public.group_members where group_id = ng and email = em_u; get diagnostics n = row_count;
  r := r || E'\n...and can''t remove the creator: ' || case when n = 0 then 'ok' else 'FAIL' end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', id_n, 'email', em_n, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := public.can_create_group();
  r := r || E'\nSigned-in person in no group: can_create_group says no: ' || case when not ok then 'ok' else 'FAIL' end;
  begin
    perform public.create_group('Sneaky');
    r := r || E'\n...and create_group is refused: FAIL';
  exception when insufficient_privilege then r := r || E'\n...and create_group is refused: ok'; end;
  reset role;

  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.create_group('Anon');
    r := r || E'\nNobody signed in: refused: FAIL';
  exception when others then r := r || E'\nNobody signed in: refused: ok'; end;

  raise exception 'GROUP CREATION TEST REPORT (rolled back):%', r;
end $$;
