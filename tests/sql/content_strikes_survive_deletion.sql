-- Copyright strikes survive account deletion (20261022130100), against a real
-- database. LOCAL STACK or the dev branch project only. One transaction ending
-- in ROLLBACK; the last line is `failures | total` (scripts/ci/sql-proof.sh
-- reads it), after any failing checks.
--
-- psql only: section 5 re-applies the migration with \ir, relative to this
-- file, to prove its backfill and that it reruns. Run from the repository root:
--
--     bash scripts/ci/sql-proof.sh "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
--         tests/sql/content_strikes_survive_deletion.sql
--
-- Launch re-audit, SF-15: deleting an account deleted its strikes, so the
-- repeat-infringer count could be reset by deleting the account and signing up
-- again with the same address.
--
-- Cast: U uploads three scores and gets two copyright strikes (one later
-- withdrawn) and an older one outside the window; V is another user; A has a
-- strike and then changes address, and B signs up with A's old one; G is a
-- guest (no address) with a strike; M moderates.

\set ON_ERROR_STOP 1

begin;

create temp table t_results (name text primary key, ok boolean not null, detail text);

grant all on t_results to public;

create function pg_temp.chk (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into t_results values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into t_results values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_msg);
        return;
    end;
    insert into t_results values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

create function pg_temp.u (p text) returns uuid language sql immutable as $$
    select ('d5100000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.d (n int) returns uuid language sql immutable as $$
    select ('d5100000-0000-4000-8000-00000000d00' || n)::uuid;
$$;

create function pg_temp.key (p_email text) returns text language sql immutable as $$
    select encode(sha256(convert_to(lower(p_email), 'UTF8')), 'hex');
$$;

-- Takes a score down for copyright, as content-moderation does; returns the takedown.
create function pg_temp.strike (n int) returns uuid language sql as $$
    select (public.apply_content_takedown (pg_temp.d (n), 'remove', 'copyright', '17 U.S.C. 512',
                                           'Matches the rights holder''s edition', null, pg_temp.u ('e1'))
            ->> 'takedown_id')::uuid;
$$;

create temp table kept (k text primary key, v uuid);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('a1'), 'authenticated', 'authenticated', 'Strike.Uploader@StrikeTest.test', false),
       (pg_temp.u ('a2'), 'authenticated', 'authenticated', 'someone.else@striketest.test', false),
       (pg_temp.u ('a3'), 'authenticated', 'authenticated', 'mover@striketest.test', false),
       (pg_temp.u ('a5'), 'authenticated', 'authenticated', null, true),
       (pg_temp.u ('a7'), 'authenticated', 'authenticated', 'direct@striketest.test', false),
       (pg_temp.u ('e1'), 'authenticated', 'authenticated', 'moderator@striketest.test', false);

insert into public.content_moderators (user_id, note) values (pg_temp.u ('e1'), 'test');

insert into public.documents (id, owner_id, title, storage_path)
select pg_temp.d (n), o, 'Score ' || n, pg_temp.d (n)::text || '/original.pdf'
from (values (1, pg_temp.u ('a1')), (2, pg_temp.u ('a1')), (3, pg_temp.u ('a1')), (4, pg_temp.u ('a3')),
             (5, pg_temp.u ('a5'))) as t (n, o);

insert into kept select 'u1', pg_temp.strike (1);
insert into kept select 'u2', pg_temp.strike (2);
insert into kept select 'u3', pg_temp.strike (3);
insert into kept select 'a', pg_temp.strike (4);
insert into kept select 'g', pg_temp.strike (5);

-- u2 is withdrawn (a counter-notice succeeded); u3 is from 13 months ago.
select public.lift_content_takedown ((select v from kept where k = 'u2'), 'Counter-notice upheld', pg_temp.u ('e1'));

update public.content_strikes set created_at = now() - interval '13 months'
where takedown_id = (select v from kept where k = 'u3');

-- ===========================================================================
-- 1. Each strike carries its uploader's address digest
-- ===========================================================================
select pg_temp.chk ('10 a strike records sha256(lower(email)) of the uploader''s address, hex', $q$
    select bool_and(s.subject_key = pg_temp.key ('strike.uploader@striketest.test')) and count(*) = 3
    from public.content_strikes s where s.user_id = pg_temp.u ('a1')$q$);

select pg_temp.chk ('11 the insert''s own subject_key is replaced by the account''s', $q$
    with t as (
        insert into public.content_takedowns (uploader_id, action, ground, legal_basis, facts)
        values (pg_temp.u ('a7'), 'restrict', 'copyright', '17 U.S.C. 512', 'Facts')
        returning id
    ), s as (
        insert into public.content_strikes (user_id, takedown_id, subject_key)
        select pg_temp.u ('a7'), t.id, 'forged' from t
        returning subject_key
    )
    select subject_key = pg_temp.key ('direct@striketest.test') from s$q$);

select pg_temp.chk ('12 a guest''s strike has no subject_key', $q$
    select subject_key is null from public.content_strikes where takedown_id = (select v from kept where k = 'g')$q$);

select pg_temp.chk ('13 U has one active strike (one withdrawn, one outside 12 months)', $q$
    select public.active_content_strikes (pg_temp.u ('a1')) = 1$q$);

-- ===========================================================================
-- 2. Deleting the account keeps the strikes
-- ===========================================================================
-- delete-account, the purges and the district hard delete all end here.
create temp table u_strikes as
select id, takedown_id, subject_key, created_at, voided_at from public.content_strikes where user_id = pg_temp.u ('a1');

delete from auth.users where id in (pg_temp.u ('a1'), pg_temp.u ('a5'));

select pg_temp.chk ('20 U''s three strikes remain, user_id null, key, date and withdrawal unchanged', $q$
    select count(*) = 3
           and bool_and(s.user_id is null and s.subject_key = b.subject_key and s.created_at = b.created_at
                        and s.voided_at is not distinct from b.voided_at)
    from u_strikes b join public.content_strikes s on s.id = b.id$q$);

select pg_temp.chk ('21 the takedowns stay too, uploader null', $q$
    select count(*) = 3 and bool_and(t.uploader_id is null)
    from public.content_takedowns t where t.id in (select takedown_id from u_strikes)$q$);

select pg_temp.chk ('22 the guest''s strike stays, attributed to nobody', $q$
    select user_id is null and subject_key is null
    from public.content_strikes where takedown_id = (select v from kept where k = 'g')$q$);

select pg_temp.chk ('23 the foreign key sets null; the takedown''s still cascades', $q$
    select (select confdeltype = 'n' from pg_constraint
            where conrelid = 'public.content_strikes'::regclass and conname = 'content_strikes_user_id_fkey')
       and (select confdeltype = 'n' from pg_constraint
            where conrelid = 'public.content_takedowns'::regclass and conname = 'content_takedowns_uploader_id_fkey')$q$);

-- ===========================================================================
-- 3. The same address signs up again
-- ===========================================================================
insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('a6'), 'authenticated', 'authenticated', 'STRIKE.UPLOADER@striketest.test', false);

select pg_temp.chk ('30 the re-registered address inherits the old active strike (any case)', $q$
    select public.active_content_strikes (pg_temp.u ('a6')) = 1$q$);

select pg_temp.chk ('31 another address is not affected', $q$
    select public.active_content_strikes (pg_temp.u ('a2')) = 0$q$);

select pg_temp.chk ('32 a new strike on the new account counts with the inherited one', $q$
    with doc as (
        insert into public.documents (id, owner_id, title, storage_path)
        values (pg_temp.d (6), pg_temp.u ('a6'), 'Score 6', pg_temp.d (6)::text || '/original.pdf')
        returning id
    )
    select (public.apply_content_takedown ((select id from doc), 'restrict', 'copyright', '17 U.S.C. 512', 'Facts',
                                           null, pg_temp.u ('e1')) ->> 'active_strikes')::int = 2$q$);

select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u ('e1'), 'role', 'authenticated')::text, true);

select pg_temp.chk ('33 the moderator''s takedown list shows the inherited count for the new account', $q$
    select (e ->> 'uploader_active_strikes')::int = 2
    from jsonb_array_elements(public.moderation_takedowns ('all') -> 'rows') e
    where e ->> 'document_id' = pg_temp.d (6)::text$q$);

select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- 4. A live account's strikes stay its own
-- ===========================================================================
update auth.users set email = 'mover.new@striketest.test' where id = pg_temp.u ('a3');

insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('a4'), 'authenticated', 'authenticated', 'mover@striketest.test', false);

select pg_temp.chk ('40 A, who changed address, keeps their strike', $q$
    select public.active_content_strikes (pg_temp.u ('a3')) = 1$q$);

select pg_temp.chk ('41 B, who took A''s old address, does not inherit it while A exists', $q$
    select public.active_content_strikes (pg_temp.u ('a4')) = 0$q$);

-- ===========================================================================
-- 5. The migration's backfill, and a rerun
-- ===========================================================================
-- A strike given before the migration: its key missing.
alter table public.content_strikes disable trigger content_strikes_set_subject_key;

update public.content_strikes set subject_key = null where user_id = pg_temp.u ('a3');

alter table public.content_strikes enable trigger content_strikes_set_subject_key;

set local client_min_messages = warning;

\ir ../../supabase/migrations/20261022130100_content_strikes_survive_deletion.sql
\ir ../../supabase/migrations/20261022130100_content_strikes_survive_deletion.sql

reset client_min_messages;

select pg_temp.chk ('50 the backfill keys an existing strike from its account''s current address', $q$
    select subject_key = pg_temp.key ('mover.new@striketest.test')
    from public.content_strikes where user_id = pg_temp.u ('a3')$q$);

select pg_temp.chk ('51 rerun: the strikes deleted accounts left keep their keys', $q$
    select bool_and(s.subject_key = b.subject_key) from u_strikes b join public.content_strikes s on s.id = b.id$q$);

select pg_temp.chk ('52 rerun: one foreign key on user_id, one trigger, one subject_key column', $q$
    select (select count(*) = 1 from pg_constraint
            where conrelid = 'public.content_strikes'::regclass and contype = 'f'
              and conkey = array[(select attnum from pg_attribute
                                  where attrelid = 'public.content_strikes'::regclass and attname = 'user_id')])
       and (select count(*) = 1 from pg_trigger
            where tgrelid = 'public.content_strikes'::regclass and tgname = 'content_strikes_set_subject_key')
       and (select count(*) = 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'content_strikes' and column_name = 'subject_key')$q$);

select pg_temp.chk ('53 rerun: the counts are unchanged', $q$
    select public.active_content_strikes (pg_temp.u ('a6')) = 2 and public.active_content_strikes (pg_temp.u ('a2')) = 0
       and public.active_content_strikes (pg_temp.u ('a3')) = 1$q$);

-- ===========================================================================
-- 6. Nothing for clients
-- ===========================================================================
select set_config('role', 'authenticated', true);

select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u ('a6'), 'role', 'authenticated')::text, true);

select pg_temp.refused ('60 a user cannot read strikes', $q$select count(*) from public.content_strikes$q$, '42501');

select pg_temp.refused ('61 ... or count anyone''s', $q$select public.active_content_strikes (pg_temp.u ('a6'))$q$, '42501');

select pg_temp.refused ('62 ... or digest an address with the internal helper',
    $q$select public.content_strike_subject_key ('x@y.test')$q$, '42501');

reset role;

select set_config('request.jwt.claims', '', true);

select pg_temp.chk ('63 the service role counts strikes; nobody calls the trigger function', $q$
    select has_function_privilege('service_role', 'public.active_content_strikes(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.active_content_strikes(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public.content_strikes_set_subject_key()', 'execute')
       and not has_function_privilege('anon', 'public.content_strike_subject_key(text)', 'execute')$q$);

-- ---------------------------------------------------------------------------
-- Report: failing checks, then `failures | total`
-- ---------------------------------------------------------------------------
select name, ok, detail from t_results where not ok order by name;

select count(*) filter (where not ok) as failures, count(*) as total from t_results;

rollback;
