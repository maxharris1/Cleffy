-- Behaviour proof for 20261112130000_view_links.sql: under-13 view links.
--
--   * Only the owner of a live score creates, rotates and revokes its link;
--     editors, viewers, roster students, share-link guests and anon are refused.
--   * Only the owner can read the row; no client role can write it.
--   * One active link per score; rotate revokes the old one.
--   * Archived and taken-down scores are refused.
--   * The service-role reads behind the view-link Edge Function answer only for
--     a live link on a live score, and never carry created_by.
--   * The retention job exists and deletes only rows dead for over 30 days.
--
-- Runs inside one transaction and ROLLS BACK. Same harness and reading as
-- tests/sql/share_link_errors.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/view_links.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('71e30000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $f$;
create function pg_temp.d(n int) returns uuid language sql immutable as $f$ select ('71e300d0-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must raise exactly this SQLSTATE.
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_message text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_message);
end $f$;
create function pg_temp.as_user(n int, anonymous boolean default false) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'is_anonymous', anonymous)::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
create function pg_temp.as_postgres() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', '', true);
perform set_config('role', 'postgres', true);
end $f$;
-- Every key anywhere in a jsonb value, recursively.
create function pg_temp.all_keys(j jsonb) returns setof text language sql immutable as $f$
    with recursive walk(v) as (
        select j
        union all
        select e.value from walk, lateral (
            select o.value from jsonb_each(case when jsonb_typeof(walk.v) = 'object' then walk.v end) o
            union all
            select a.value from jsonb_array_elements(case when jsonb_typeof(walk.v) = 'array' then walk.v end) a
        ) e
    )
    select k from walk, jsonb_object_keys(walk.v) k where jsonb_typeof(walk.v) = 'object'
$f$;

-- 1 owner, 2 editor, 3 viewer, 4 stranger, 5 a guest who owns a score,
-- 6 a roster student who owns a score, 7 the student's teacher.
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
(pg_temp.u(1), 'owner@viewlinks.test', '{}', false),
(pg_temp.u(2), 'editor@viewlinks.test', '{}', false),
(pg_temp.u(3), 'viewer@viewlinks.test', '{}', false),
(pg_temp.u(4), 'stranger@viewlinks.test', '{}', false),
(pg_temp.u(5), null, '{}', true),
(pg_temp.u(6), 'student@viewlinks.test', '{}', false),
(pg_temp.u(7), 'teacher@viewlinks.test', '{}', false);
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash)
values ('71e30005-0000-4000-8000-000000000006', pg_temp.u(7), pg_temp.u(6), 'Student', 'hash');

-- d1 live; d2 archived; d3 taken down (restrict: the owner still sees it);
-- d4 owned by the guest; d5 owned by the student; d6 a second live score.
-- The owner is on the free plan (three live cloud scores), so the archived one
-- goes in archived.
insert into public.documents (id, owner_id, title, storage_path, page_count) values
(pg_temp.d(1), pg_temp.u(1), 'Live', pg_temp.d(1)::text || '/original.pdf', 3),
(pg_temp.d(3), pg_temp.u(1), 'Taken down', pg_temp.d(3)::text || '/original.pdf', 1),
(pg_temp.d(4), pg_temp.u(5), 'Guest''s', pg_temp.d(4)::text || '/original.pdf', 1),
(pg_temp.d(5), pg_temp.u(6), 'Student''s', pg_temp.d(5)::text || '/original.pdf', 1),
(pg_temp.d(6), pg_temp.u(1), 'Second', pg_temp.d(6)::text || '/original.pdf', 2);
insert into public.documents (id, owner_id, title, storage_path, page_count, archived_at) values
(pg_temp.d(2), pg_temp.u(1), 'Archived', pg_temp.d(2)::text || '/original.pdf', 1, now());
insert into public.document_members (document_id, user_id, role) values
(pg_temp.d(1), pg_temp.u(2), 'editor'),
(pg_temp.d(1), pg_temp.u(3), 'viewer');
insert into public.content_takedowns (document_id, uploader_id, action, ground, legal_basis, facts)
values (pg_temp.d(3), pg_temp.u(1), 'restrict', 'copyright', '17 U.S.C. 512', 'Facts');
insert into storage.objects (bucket_id, name, owner, metadata) values
('scores', pg_temp.d(1)::text || '/original.pdf', pg_temp.u(1), '{"size": 1234567, "mimetype": "application/pdf"}');
insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values
('71e300a0-0000-4000-8000-000000000001', pg_temp.d(1), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(2)),
('71e300a0-0000-4000-8000-000000000002', pg_temp.d(1), 1, 'highlight', '#ff0', '{"pts":[0,0,1],"w":0.02}', pg_temp.u(1)),
('71e300a0-0000-4000-8000-000000000009', pg_temp.d(6), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(1));

-- ---- the table
select pg_temp.chk('01 view_links exists with RLS on', $q$select relrowsecurity from pg_class where oid = 'public.view_links'::regclass$q$);
select pg_temp.chk('02 expires_at defaults to 90 days out', $q$
    select pg_get_expr(d.adbin, d.adrelid) like '%90 days%'
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.view_links'::regclass and a.attname = 'expires_at'$q$);

-- ---- owner: create, idempotent, rotate, revoke
select pg_temp.as_user(1);
create temp table t_tok (step text primary key, token text);
grant all on t_tok to authenticated, anon, service_role;
insert into t_tok select 'first', public.create_view_link(pg_temp.d(1));
select pg_temp.chk('10 the owner creates a link: 32 random bytes, base64url', $q$select token ~ '^[A-Za-z0-9_-]{43}$' from t_tok where step = 'first'$q$);
insert into t_tok select 'again', public.create_view_link(pg_temp.d(1));
select pg_temp.chk('11 create again returns the active link as is', $q$select (select token from t_tok where step = 'again') = (select token from t_tok where step = 'first')$q$);
select pg_temp.chk('12 the owner can read the row', $q$select count(*) = 1 from public.view_links where document_id = pg_temp.d(1)$q$);
insert into t_tok select 'rotated', public.rotate_view_link(pg_temp.d(1));
select pg_temp.chk('13 rotate makes a new token', $q$select (select token from t_tok where step = 'rotated') <> (select token from t_tok where step = 'first')
    and (select token from t_tok where step = 'rotated') ~ '^[A-Za-z0-9_-]{43}$'$q$);
select pg_temp.chk('14 ... and revokes the old one', $q$select revoked_at is not null from public.view_links where token = (select token from t_tok where step = 'first')$q$);
select pg_temp.chk('15 ... leaving one active link', $q$select count(*) = 1 from public.view_links where document_id = pg_temp.d(1) and revoked_at is null$q$);
select public.revoke_view_link(pg_temp.d(1));
select pg_temp.chk('16 revoke leaves no active link', $q$select count(*) = 0 from public.view_links where document_id = pg_temp.d(1) and revoked_at is null$q$);
insert into t_tok select 'after_revoke', public.create_view_link(pg_temp.d(1));
select pg_temp.chk('17 create after revoke makes a fresh token', $q$select (select token from t_tok where step = 'after_revoke') not in (select token from t_tok where step in ('first', 'rotated'))$q$);
select pg_temp.chk('18 revoking with no active link is a no-op, not an error', $q$select public.revoke_view_link(pg_temp.d(6)) is null or true$q$);
insert into t_tok select 'second_doc', public.create_view_link(pg_temp.d(6));

-- ---- refused callers
select pg_temp.as_user(2);
select pg_temp.refused('20 an editor cannot create', $q$select public.create_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.refused('21 an editor cannot rotate', $q$select public.rotate_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.refused('22 an editor cannot revoke', $q$select public.revoke_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.chk('23 an editor cannot read the row', $q$select count(*) = 0 from public.view_links$q$);
select pg_temp.as_user(3);
select pg_temp.refused('24 a viewer cannot create', $q$select public.create_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.chk('25 a viewer cannot read the row', $q$select count(*) = 0 from public.view_links$q$);
select pg_temp.as_user(4);
select pg_temp.refused('26 a stranger cannot create', $q$select public.create_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.chk('27 a stranger cannot read the row', $q$select count(*) = 0 from public.view_links$q$);
select pg_temp.as_user(5, true);
select pg_temp.refused('28 a share-link guest cannot create, even on a score they own', $q$select public.create_view_link(pg_temp.d(4))$q$, '42501');
select pg_temp.as_user(6);
select pg_temp.refused('29 a roster student cannot create, even on a score they own', $q$select public.create_view_link(pg_temp.d(5))$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('30 anon cannot call create', $q$select public.create_view_link(pg_temp.d(1))$q$, '42501');
select pg_temp.refused('31 anon cannot read the table', $q$select count(*) from public.view_links$q$, '42501');
select pg_temp.as_postgres();
select set_config('request.jwt.claims', '', true);
select pg_temp.as_user(1);
select pg_temp.refused('32 the owner cannot insert directly', $q$insert into public.view_links (document_id, created_by) values (pg_temp.d(1), pg_temp.u(1))$q$, '42501');
select pg_temp.refused('33 the owner cannot update directly', $q$update public.view_links set revoked_at = null$q$, '42501');
select pg_temp.refused('34 the owner cannot delete directly', $q$delete from public.view_links$q$, '42501');

-- ---- refused scores
select pg_temp.refused('40 an archived score is refused', $q$select public.create_view_link(pg_temp.d(2))$q$, '42501');
select pg_temp.refused('41 a taken-down score is refused, even to its owner', $q$select public.create_view_link(pg_temp.d(3))$q$, '42501');
select pg_temp.refused('42 an unknown score is refused', $q$select public.create_view_link('71e300d0-0000-4000-8000-0000000000ff')$q$, '42501');
select pg_temp.as_postgres();
select set_config('request.jwt.claims', '', true);
select pg_temp.refused('43 no session is refused', $q$select public.create_view_link(pg_temp.d(1))$q$, '28000');

-- ---- one active link per score
select pg_temp.refused('44 a second active row for a score is impossible', $q$
    insert into public.view_links (document_id, created_by) values (pg_temp.d(1), pg_temp.u(1))$q$, '23505');

-- ---- the service-role reads
select pg_temp.as_service();
create temp table t_poll (step text primary key, body jsonb);
grant all on t_poll to service_role;
insert into t_poll select 'live', public.view_link_poll((select token from t_tok where step = 'after_revoke'), 0, 500);
select pg_temp.chk('50 a live link answers with the doc and its marks', $q$
    select (body -> 'doc' ->> 'pages')::int = 3
       and (body -> 'doc' ->> 'pdf_rev')::int = 0
       and jsonb_array_length(body -> 'annotations') = 2
       and (body ->> 'pdf_bytes')::bigint = 1234567
       and (body ->> 'max_seq')::bigint > 0
       and (body ->> 'more')::boolean = false
    from t_poll where step = 'live'$q$);
select pg_temp.chk('51 no created_by, owner, email or name anywhere in the answer', $q$
    select not exists (
        select 1 from t_poll, pg_temp.all_keys(body) k
        where step = 'live' and k in ('created_by', 'createdBy', 'owner_id', 'email', 'display_name', 'name', 'storage_path', 'document_id', 'created_at', 'updated_at')
    )$q$);
select pg_temp.chk('52 each mark carries exactly id, page, kind, color, payload, seq, deleted', $q$
    select bool_and((select array_agg(k order by k) from jsonb_object_keys(a) k) = array['color', 'deleted', 'id', 'kind', 'page', 'payload', 'seq'])
    from t_poll, jsonb_array_elements(body -> 'annotations') a where step = 'live'$q$);
select pg_temp.chk('53 marks of another score are not included', $q$
    select not exists (select 1 from t_poll, jsonb_array_elements(body -> 'annotations') a
                       where step = 'live' and a ->> 'id' = '71e300a0-0000-4000-8000-000000000009')$q$);
select pg_temp.chk('54 since filters to newer marks', $q$
    select jsonb_array_length(public.view_link_poll((select token from t_tok where step = 'after_revoke'),
        (select (body ->> 'max_seq')::bigint from t_poll where step = 'live'), 500) -> 'annotations') = 0$q$);
select pg_temp.chk('55 a page limit sets more and the watermark of what was sent', $q$
    with p as (select public.view_link_poll((select token from t_tok where step = 'after_revoke'), 0, 1) as b)
    select jsonb_array_length(b -> 'annotations') = 1 and (b ->> 'more')::boolean
       and (b ->> 'max_seq')::bigint = ((b -> 'annotations' -> 0) ->> 'seq')::bigint from p$q$);
select pg_temp.as_postgres();
update public.annotations set deleted_at = now() where id = '71e300a0-0000-4000-8000-000000000001';
select pg_temp.as_service();
select pg_temp.chk('56 an erased mark comes back as a tombstone', $q$
    select a ->> 'deleted' = 'true'
    from jsonb_array_elements(public.view_link_poll((select token from t_tok where step = 'after_revoke'),
        (select (body ->> 'max_seq')::bigint from t_poll where step = 'live'), 500) -> 'annotations') a
    where a ->> 'id' = '71e300a0-0000-4000-8000-000000000001'$q$);
select pg_temp.chk('57 the pdf read gives the object and its size', $q$
    select storage_path = pg_temp.d(1)::text || '/original.pdf' and pdf_bytes = 1234567
    from public.view_link_pdf((select token from t_tok where step = 'after_revoke'))$q$);
select pg_temp.chk('58 a revoked link answers null', $q$select public.view_link_poll((select token from t_tok where step = 'first'), 0, 500) is null$q$);
select pg_temp.chk('59 a rotated-away link answers null', $q$select public.view_link_poll((select token from t_tok where step = 'rotated'), 0, 500) is null$q$);
select pg_temp.chk('60 an unknown token answers null', $q$select public.view_link_poll(repeat('A', 43), 0, 500) is null$q$);
select pg_temp.chk('61 a revoked link has no pdf', $q$select count(*) = 0 from public.view_link_pdf((select token from t_tok where step = 'first'))$q$);
select pg_temp.as_postgres();
update public.view_links set expires_at = now() - interval '1 second' where token = (select token from t_tok where step = 'second_doc');
select pg_temp.as_service();
select pg_temp.chk('62 an expired link answers null', $q$select public.view_link_poll((select token from t_tok where step = 'second_doc'), 0, 500) is null$q$);
select pg_temp.as_postgres();
update public.documents set archived_at = now() where id = pg_temp.d(1);
select pg_temp.as_service();
select pg_temp.chk('63 a link to a score archived since answers null', $q$select public.view_link_poll((select token from t_tok where step = 'after_revoke'), 0, 500) is null$q$);
select pg_temp.as_postgres();
update public.documents set archived_at = null where id = pg_temp.d(1);
insert into public.content_takedowns (document_id, uploader_id, action, ground, legal_basis, facts)
values (pg_temp.d(1), pg_temp.u(1), 'restrict', 'terms', 'Terms 4', 'Facts');
select pg_temp.as_service();
select pg_temp.chk('64 a link to a score taken down since answers null', $q$select public.view_link_poll((select token from t_tok where step = 'after_revoke'), 0, 500) is null
    and not exists (select 1 from public.view_link_pdf((select token from t_tok where step = 'after_revoke')))$q$);
select pg_temp.as_postgres();
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('65 the reads wrote nothing: still the four links the owner made', $q$
    select count(*) = 4 from public.view_links$q$);

-- ---- grants
select pg_temp.chk('70 create/rotate/revoke: authenticated only, not anon, not PUBLIC', $q$
    select bool_and(has_function_privilege('authenticated', f, 'execute')
                    and not has_function_privilege('anon', f, 'execute')
                    and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = f and a.grantee = 0))
    from unnest(array['public.create_view_link(uuid)'::regprocedure, 'public.rotate_view_link(uuid)'::regprocedure,
                      'public.revoke_view_link(uuid)'::regprocedure]) f$q$);
select pg_temp.chk('71 the Edge Function reads: service_role only', $q$
    select bool_and(has_function_privilege('service_role', f, 'execute')
                    and not has_function_privilege('anon', f, 'execute')
                    and not has_function_privilege('authenticated', f, 'execute'))
    from unnest(array['public.view_link_poll(text, bigint, integer)'::regprocedure, 'public.view_link_pdf(text)'::regprocedure]) f$q$);
select pg_temp.chk('72 all definer functions with an empty search_path', $q$
    select bool_and(prosecdef and proconfig @> array['search_path=""']) and count(*) = 6
    from pg_proc where oid in ('public.create_view_link(uuid)'::regprocedure, 'public.rotate_view_link(uuid)'::regprocedure,
        'public.revoke_view_link(uuid)'::regprocedure, 'public.view_link_poll(text, bigint, integer)'::regprocedure,
        'public.view_link_pdf(text)'::regprocedure, 'public.view_links_retention_purge()'::regprocedure)$q$);
select pg_temp.chk('73 table grants: owner SELECT through RLS, nothing else for clients, all for service_role', $q$
    select has_table_privilege('authenticated', 'public.view_links', 'SELECT')
       and not has_table_privilege('authenticated', 'public.view_links', 'INSERT, UPDATE, DELETE, TRUNCATE')
       and not has_any_column_privilege('anon', 'public.view_links', 'SELECT, INSERT, UPDATE')
       and has_table_privilege('service_role', 'public.view_links', 'SELECT, INSERT, UPDATE, DELETE')$q$);

-- ---- retention
select pg_temp.chk('80 the retention cron job is scheduled', $q$
    select count(*) = 1 from cron.job where jobname = 'retention-view-links'
       and command like '%view_links_retention_purge%'$q$);
select pg_temp.chk('81 the purge is not callable by clients', $q$
    select not has_function_privilege('anon', 'public.view_links_retention_purge()', 'execute')
       and not has_function_privilege('authenticated', 'public.view_links_retention_purge()', 'execute')$q$);
update public.view_links set revoked_at = now() - interval '31 days' where token = (select token from t_tok where step = 'first');
update public.view_links set revoked_at = now() - interval '29 days' where token = (select token from t_tok where step = 'rotated');
update public.view_links set expires_at = now() - interval '31 days' where token = (select token from t_tok where step = 'second_doc');
select pg_temp.chk('82 the purge deletes rows revoked or expired over 30 days ago', $q$select public.view_links_retention_purge() = 2$q$);
select pg_temp.chk('83 ... and keeps the rest', $q$
    select (select array_agg(token order by token) from public.view_links)
         = (select array_agg(token order by token) from t_tok where step in ('rotated', 'after_revoke'))$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
