-- Copyright strikes survive account deletion (20261022130100), against a real
-- database. LOCAL STACK or the dev branch project only. One transaction ending
-- in ROLLBACK; the last line is `failures | total` (scripts/ci/sql-proof.sh
-- reads it), after any failing checks.
--
-- psql only: section 7 re-applies the migration with \ir, relative to this
-- file, to prove that it reruns. Run from the repository root:
--
--     bash scripts/ci/sql-proof.sh "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
--         tests/sql/content_strikes_survive_deletion.sql
--
-- Launch re-audit, SF-15: deleting an account deleted its strikes, so the
-- repeat-infringer count could be reset by deleting the account and signing up
-- again with the same address. Codex round 1 on #66: the key must be the
-- address the account has when it is deleted (major 1), and a keyed HMAC whose
-- pepper lives in Vault, purged 12 months after the newest strike (major 2).
--
-- Needs the Vault secret content_strike_pepper (supabase/seed.sql seeds a dev
-- value on a local stack and in CI).
--
-- Cast: U uploads three scores and gets two copyright strikes (one later
-- withdrawn) and an older one outside the window; V is another user; A has a
-- strike and then changes address, B signs up with A's old one, A deletes
-- their account and A2 signs up with A's latest address; G is a guest (no
-- address) with a strike; P has a strike and is deleted while the pepper is
-- missing; N has none; M moderates.

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

-- The expected key: hex(hmac-sha256(pepper, lower(btrim(email)))), version 1.
create function pg_temp.key (p_email text) returns text language sql stable as $$
    select encode(extensions.hmac(convert_to(lower(btrim(p_email)), 'UTF8'),
                                  convert_to((select decrypted_secret from vault.decrypted_secrets
                                              where name = 'content_strike_pepper'), 'UTF8'), 'sha256'), 'hex');
$$;

-- Hide and restore the pepper (a rename, through Vault's own function), inside
-- this transaction.
create function pg_temp.pepper_hidden (p_hidden boolean) returns void language plpgsql as $$
declare
    v_from text := case when p_hidden then 'content_strike_pepper' else 'content_strike_pepper_hidden_by_proof' end;
    v_to text := case when p_hidden then 'content_strike_pepper_hidden_by_proof' else 'content_strike_pepper' end;
begin
    perform vault.update_secret (d.id, null, v_to) from vault.decrypted_secrets d where d.name = v_from;
end;
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
       (pg_temp.u ('a8'), 'authenticated', 'authenticated', 'no.strikes@striketest.test', false),
       (pg_temp.u ('a9'), 'authenticated', 'authenticated', 'pepperless@striketest.test', false),
       (pg_temp.u ('e1'), 'authenticated', 'authenticated', 'moderator@striketest.test', false);

insert into public.content_moderators (user_id, note) values (pg_temp.u ('e1'), 'test');

insert into public.documents (id, owner_id, title, storage_path)
select pg_temp.d (n), o, 'Score ' || n, pg_temp.d (n)::text || '/original.pdf'
from (values (1, pg_temp.u ('a1')), (2, pg_temp.u ('a1')), (3, pg_temp.u ('a1')), (4, pg_temp.u ('a3')),
             (5, pg_temp.u ('a5')), (7, pg_temp.u ('a9'))) as t (n, o);

insert into kept select 'u1', pg_temp.strike (1);
insert into kept select 'u2', pg_temp.strike (2);
insert into kept select 'u3', pg_temp.strike (3);
insert into kept select 'a', pg_temp.strike (4);
insert into kept select 'g', pg_temp.strike (5);
insert into kept select 'p', pg_temp.strike (7);

-- u2 is withdrawn (a counter-notice succeeded); u3 is from 13 months ago.
select public.lift_content_takedown ((select v from kept where k = 'u2'), 'Counter-notice upheld', pg_temp.u ('e1'));

update public.content_strikes set created_at = now() - interval '13 months'
where takedown_id = (select v from kept where k = 'u3');

-- ===========================================================================
-- 0. The pepper
-- ===========================================================================
select pg_temp.chk ('00 the Vault secret content_strike_pepper is set', $q$
    select exists (select 1 from vault.decrypted_secrets where name = 'content_strike_pepper'
                   and coalesce(decrypted_secret, '') <> '')$q$);

-- ===========================================================================
-- 1. A live strike carries no key
-- ===========================================================================
select pg_temp.chk ('10 a live account''s strikes are unkeyed: they count by user_id', $q$
    select bool_and(s.subject_key is null and s.subject_key_version is null) and count(*) = 3
    from public.content_strikes s where s.user_id = pg_temp.u ('a1')$q$);

select pg_temp.chk ('11 a key the insert supplies is dropped', $q$
    with t as (
        insert into public.content_takedowns (uploader_id, action, ground, legal_basis, facts)
        values (pg_temp.u ('a7'), 'restrict', 'copyright', '17 U.S.C. 512', 'Facts')
        returning id
    ), s as (
        insert into public.content_strikes (user_id, takedown_id, subject_key, subject_key_version)
        select pg_temp.u ('a7'), t.id, 'forged', 1 from t
        returning subject_key, subject_key_version
    )
    select subject_key is null and subject_key_version is null from s$q$);

select pg_temp.chk ('12 U has one active strike (one withdrawn, one outside 12 months)', $q$
    select public.active_content_strikes (pg_temp.u ('a1')) = 1$q$);

-- ===========================================================================
-- 2. Deleting the account keeps the strikes, keyed with the address it has then
-- ===========================================================================
-- delete-account, the purges and the district hard delete all end here.
create temp table u_strikes as
select id, takedown_id, created_at, voided_at from public.content_strikes where user_id = pg_temp.u ('a1');

delete from auth.users where id in (pg_temp.u ('a1'), pg_temp.u ('a5'));

select pg_temp.chk ('20 U''s three strikes remain, user_id null, date and withdrawal unchanged', $q$
    select count(*) = 3
           and bool_and(s.user_id is null and s.created_at = b.created_at and s.voided_at is not distinct from b.voided_at)
    from u_strikes b join public.content_strikes s on s.id = b.id$q$);

select pg_temp.chk ('21 the strike that counts is keyed: version 1, hmac-sha256(pepper, lower(btrim(email)))', $q$
    select s.subject_key_version = 1 and s.subject_key = pg_temp.key ('strike.uploader@striketest.test')
    from public.content_strikes s where s.takedown_id = (select v from kept where k = 'u1')$q$);

select pg_temp.chk ('22 the key is no plain digest of the address', $q$
    select s.subject_key <> encode(sha256(convert_to('strike.uploader@striketest.test', 'UTF8')), 'hex')
       and s.subject_key <> encode(sha256(convert_to('Strike.Uploader@StrikeTest.test', 'UTF8')), 'hex')
    from public.content_strikes s where s.takedown_id = (select v from kept where k = 'u1')$q$);

select pg_temp.chk ('23 the withdrawn strike and the one outside the window stay unkeyed', $q$
    select bool_and(s.subject_key is null and s.subject_key_version is null) and count(*) = 2
    from public.content_strikes s where s.takedown_id in (select v from kept where k in ('u2', 'u3'))$q$);

select pg_temp.chk ('24 the takedowns stay too, uploader null', $q$
    select count(*) = 3 and bool_and(t.uploader_id is null)
    from public.content_takedowns t where t.id in (select takedown_id from u_strikes)$q$);

select pg_temp.chk ('25 the guest''s strike stays, attributed to nobody and unkeyed', $q$
    select user_id is null and subject_key is null
    from public.content_strikes where takedown_id = (select v from kept where k = 'g')$q$);

select pg_temp.chk ('26 the foreign key sets null; the takedown''s too', $q$
    select (select confdeltype = 'n' from pg_constraint
            where conrelid = 'public.content_strikes'::regclass and conname = 'content_strikes_user_id_fkey')
       and (select confdeltype = 'n' from pg_constraint
            where conrelid = 'public.content_takedowns'::regclass and conname = 'content_takedowns_uploader_id_fkey')$q$);

-- Fail closed: without the pepper, an account with a strike to key cannot be
-- deleted (and is still there); one without strikes can.
select pg_temp.pepper_hidden (true);

select pg_temp.refused ('27 no pepper: deleting an account with an active strike is refused (55000)',
    $q$delete from auth.users where id = pg_temp.u ('a9')$q$, '55000');

select pg_temp.chk ('28 ... and the account and its unkeyed strike are still there', $q$
    select exists (select 1 from auth.users where id = pg_temp.u ('a9'))
       and (select user_id = pg_temp.u ('a9') and subject_key is null from public.content_strikes
            where takedown_id = (select v from kept where k = 'p'))$q$);

select pg_temp.refused ('29 no pepper: counting strikes while keyed ones exist is refused (55000)',
    $q$select public.active_content_strikes (pg_temp.u ('a2'))$q$, '55000');

select pg_temp.chk ('2a no pepper: an account with no strikes is still deleted', $q$
    with d as (delete from auth.users where id = pg_temp.u ('a8') returning id) select count(*) = 1 from d$q$);

select pg_temp.pepper_hidden (false);

delete from auth.users where id = pg_temp.u ('a9');

select pg_temp.chk ('2b the pepper is back: the same delete now goes through and keys the strike', $q$
    select not exists (select 1 from auth.users where id = pg_temp.u ('a9'))
       and (select subject_key = pg_temp.key ('pepperless@striketest.test') and user_id is null
            from public.content_strikes where takedown_id = (select v from kept where k = 'p'))$q$);

-- ===========================================================================
-- 3. Delete, then the same address signs up again: it inherits
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
-- 4. A changes address, B takes the old one, A deletes
-- ===========================================================================
update auth.users set email = 'mover.new@striketest.test' where id = pg_temp.u ('a3');

insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('a4'), 'authenticated', 'authenticated', 'mover@striketest.test', false);

select pg_temp.chk ('40 A, who changed address, keeps their strike', $q$
    select public.active_content_strikes (pg_temp.u ('a3')) = 1$q$);

select pg_temp.chk ('41 B, who took A''s old address, does not inherit it while A exists', $q$
    select public.active_content_strikes (pg_temp.u ('a4')) = 0$q$);

delete from auth.users where id = pg_temp.u ('a3');

select pg_temp.chk ('42 A''s strike is keyed with the address A had when deleted, not the one it was given at', $q$
    select subject_key = pg_temp.key ('mover.new@striketest.test')
       and subject_key <> pg_temp.key ('mover@striketest.test')
    from public.content_strikes where takedown_id = (select v from kept where k = 'a')$q$);

select pg_temp.chk ('43 B, on A''s old address, still inherits nothing after A is deleted', $q$
    select public.active_content_strikes (pg_temp.u ('a4')) = 0$q$);

insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('b1'), 'authenticated', 'authenticated', 'Mover.New@StrikeTest.test', false);

select pg_temp.chk ('44 a sign-up on A''s latest address inherits A''s strike', $q$
    select public.active_content_strikes (pg_temp.u ('b1')) = 1$q$);

-- ===========================================================================
-- 5. Only strikes inside the window are inherited
-- ===========================================================================
update public.content_strikes set created_at = now() - interval '12 months 1 day'
where takedown_id = (select v from kept where k = 'a');

select pg_temp.chk ('50 once A''s strike is past 12 months, A2 inherits nothing', $q$
    select public.active_content_strikes (pg_temp.u ('b1')) = 0$q$);

update public.content_strikes set created_at = now() - interval '11 months'
where takedown_id = (select v from kept where k = 'a');

-- ===========================================================================
-- 6. Retention: 12 months after the newest strike under a key
-- ===========================================================================
-- U's address: u1 (keyed, now 13 months old) and, under the same key, one
-- 2 months old. A's key: one strike, 13 months old. U's unkeyed ones: u2
-- (withdrawn, made 13 months old) and u3 (13 months). The guest's: today.
update public.content_strikes set created_at = now() - interval '13 months'
where takedown_id in (select v from kept where k in ('u1', 'u2', 'a'));

insert into public.content_takedowns (id, uploader_id, action, ground, legal_basis, facts)
values ('d5100000-0000-4000-8000-0000000000f1', null, 'restrict', 'copyright', '17 U.S.C. 512', 'Facts');

insert into public.content_strikes (user_id, takedown_id) values (null, 'd5100000-0000-4000-8000-0000000000f1');

update public.content_strikes
set subject_key = pg_temp.key ('strike.uploader@striketest.test'), subject_key_version = 1,
    created_at = now() - interval '2 months'
where takedown_id = 'd5100000-0000-4000-8000-0000000000f1';

-- A live account's strike older than 12 months: never this job's.
update public.content_strikes set created_at = now() - interval '13 months' where user_id = pg_temp.u ('a7');

select pg_temp.chk ('60 the purge removes A''s key and U''s two unkeyed old strikes, three rows', $q$
    select public.retention_purge_content_strikes () = 3$q$);

select pg_temp.chk ('61 A''s strike is gone (its newest strike is over 12 months old)', $q$
    select not exists (select 1 from public.content_strikes where takedown_id = (select v from kept where k = 'a'))$q$);

select pg_temp.chk ('62 U''s 13-month-old keyed strike stays while a newer one shares its key', $q$
    select exists (select 1 from public.content_strikes where takedown_id = (select v from kept where k = 'u1'))
       and exists (select 1 from public.content_strikes where takedown_id = 'd5100000-0000-4000-8000-0000000000f1')$q$);

select pg_temp.chk ('63 U''s unkeyed strikes older than 12 months are gone; the guest''s from today stays', $q$
    select not exists (select 1 from public.content_strikes where takedown_id in (select v from kept where k in ('u2', 'u3')))
       and exists (select 1 from public.content_strikes where takedown_id = (select v from kept where k = 'g'))$q$);

select pg_temp.chk ('64 a live account''s old strike and every takedown stay', $q$
    select exists (select 1 from public.content_strikes where user_id = pg_temp.u ('a7'))
       and (select count(*) = 3 from public.content_takedowns where id in (select takedown_id from u_strikes))
       and exists (select 1 from public.content_takedowns where id = (select v from kept where k = 'a'))$q$);

update public.content_strikes set created_at = now() - interval '12 months 1 day'
where takedown_id = 'd5100000-0000-4000-8000-0000000000f1';

insert into kept select 'purged_' || public.retention_purge_content_strikes (), null;

select pg_temp.chk ('65 once the newest is past 12 months too, the whole key goes (two rows)', $q$
    select exists (select 1 from kept where k = 'purged_2')
       and not exists (select 1 from public.content_strikes
                       where subject_key = pg_temp.key ('strike.uploader@striketest.test'))$q$);

select pg_temp.chk ('66 it runs daily as retention-content-strikes, scheduled once and active', $q$
    select count(*) = 1 and bool_and(active and command = 'select public.retention_purge_content_strikes ()')
    from cron.job where jobname = 'retention-content-strikes'$q$);

-- ===========================================================================
-- 7. A rerun
-- ===========================================================================
set local client_min_messages = warning;

\ir ../../supabase/migrations/20261022130100_content_strikes_survive_deletion.sql
\ir ../../supabase/migrations/20261022130100_content_strikes_survive_deletion.sql

reset client_min_messages;

select pg_temp.chk ('70 rerun: the key a deleted account left is unchanged', $q$
    select subject_key = pg_temp.key ('pepperless@striketest.test') and subject_key_version = 1
    from public.content_strikes where takedown_id = (select v from kept where k = 'p')$q$);

select pg_temp.chk ('71 rerun: one foreign key on user_id, each trigger once, each column once, one job', $q$
    select (select count(*) = 1 from pg_constraint
            where conrelid = 'public.content_strikes'::regclass and contype = 'f'
              and conkey = array[(select attnum from pg_attribute
                                  where attrelid = 'public.content_strikes'::regclass and attname = 'user_id')])
       and (select count(*) = 1 from pg_trigger
            where tgrelid = 'public.content_strikes'::regclass and tgname = 'content_strikes_set_subject_key')
       and (select count(*) = 1 from pg_trigger
            where tgrelid = 'auth.users'::regclass and tgname = 'content_strikes_key_on_account_delete')
       and (select count(*) = 2 from information_schema.columns
            where table_schema = 'public' and table_name = 'content_strikes'
              and column_name in ('subject_key', 'subject_key_version'))
       and (select count(*) = 1 from cron.job where jobname = 'retention-content-strikes')$q$);

select pg_temp.chk ('72 rerun: the counts are unchanged', $q$
    select public.active_content_strikes (pg_temp.u ('a6')) = 1 and public.active_content_strikes (pg_temp.u ('a2')) = 0
       and public.active_content_strikes (pg_temp.u ('a4')) = 0$q$);

-- ===========================================================================
-- 8. Nothing for clients
-- ===========================================================================
select set_config('role', 'authenticated', true);

select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u ('a6'), 'role', 'authenticated')::text, true);

select pg_temp.refused ('80 a user cannot read strikes', $q$select count(*) from public.content_strikes$q$, '42501');

select pg_temp.refused ('81 ... or count anyone''s', $q$select public.active_content_strikes (pg_temp.u ('a6'))$q$, '42501');

select pg_temp.refused ('82 ... or key an address with the internal helper',
    $q$select public.content_strike_subject_key ('x@y.test', 1::smallint)$q$, '42501');

select pg_temp.refused ('83 ... or read the pepper', $q$select public.content_strike_pepper (1::smallint)$q$, '42501');

select pg_temp.refused ('84 ... or run the purge', $q$select public.retention_purge_content_strikes ()$q$, '42501');

reset role;

select set_config('request.jwt.claims', '', true);

select pg_temp.chk ('85 the service role counts and purges; only definer code keys or reads the pepper', $q$
    select has_function_privilege('service_role', 'public.active_content_strikes(uuid)', 'execute')
       and has_function_privilege('service_role', 'public.retention_purge_content_strikes(interval, int)', 'execute')
       and not has_function_privilege('anon', 'public.active_content_strikes(uuid)', 'execute')
       and not has_function_privilege('service_role', 'public.content_strike_pepper(smallint)', 'execute')
       and not has_function_privilege('service_role', 'public.content_strike_subject_key(text, smallint)', 'execute')
       and not has_function_privilege('authenticated', 'public.content_strikes_set_subject_key()', 'execute')
       and not has_function_privilege('authenticated', 'public.content_strikes_key_on_account_delete()', 'execute')
       and to_regprocedure('public.content_strike_subject_key(text)') is null$q$);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select name, ok, detail from t_results order by name;

select count(*) filter (where not ok) as failures, count(*) as total from t_results;

rollback;
