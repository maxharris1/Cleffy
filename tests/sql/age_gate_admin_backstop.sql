-- Behaviour proof for 20261111170000_age_gate_auth_users_insert.sql: the
-- age-gate INSERT trigger on auth.users, which is the database backstop for
-- GoTrue's admin API createUser (that path skips before_user_created).
--
-- postgres cannot SET ROLE supabase_auth_admin on the local image (it is not
-- a superuser and not a member), so the GoTrue inserts are issued over
-- dblink as supabase_auth_admin — the same login GoTrue uses. That session
-- is its own transaction: this file BEGINs it, ROLLBACKs it, and disconnects.
-- The outer transaction (this file's) also ROLLS BACK.
--
-- Same harness and reading as tests/sql/checkout_consents.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/age_gate_admin_backstop.sql
--
-- The dblink session logs in with the local stack's password; pass
-- -v peer_password=... for any other. Every row of the result table should
-- read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;

create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;

create extension if not exists dblink with schema extensions;
select set_config('ag.peer_password', :'peer_password', true);
create function pg_temp.gotrue_conn() returns text language sql as $f$
    -- 127.0.0.1 is `trust` on the local image, and dblink from a non-superuser
    -- then refuses even with a password in the string. GoTrue (and this
    -- session, when inet_server_addr is null) reaches the db on the docker
    -- network, which uses scram-sha-256.
    select format('host=%s port=%s dbname=%s user=supabase_auth_admin password=%s',
        coalesce(nullif(host(inet_server_addr()), '127.0.0.1'), 'supabase_db_cleffy'),
        coalesce(inet_server_port(), 5432),
        current_database(),
        current_setting('ag.peer_password'))
$f$;

-- Run SQL as supabase_auth_admin inside a savepoint so a refusal does not
-- abort the GoTrue-shaped session.
create function pg_temp.gotrue_exec(p_sql text) returns text language plpgsql as $f$
declare
    v text;
begin
    perform extensions.dblink_exec('gotrue', 'savepoint ag', false);
    v := extensions.dblink_exec('gotrue', p_sql, false);
    if v like 'ERROR%' then
        v := v || ' ' || coalesce(extensions.dblink_error_message('gotrue'), '');
        perform extensions.dblink_exec('gotrue', 'rollback to savepoint ag', false);
    else
        perform extensions.dblink_exec('gotrue', 'release savepoint ag', false);
    end if;
    return v;
end $f$;

create function pg_temp.gotrue_check(p_name text, p_sql text, p_like text) returns void language plpgsql as $f$
declare
    v text;
begin
    v := pg_temp.gotrue_exec(p_sql);
    insert into t_results values (p_name, v like p_like, v);
end $f$;

select extensions.dblink_connect('gotrue', pg_temp.gotrue_conn());
select extensions.dblink_exec('gotrue', 'begin');

-- ---- the trigger itself
select pg_temp.chk('01 the backstop is an enabled BEFORE INSERT ROW trigger on auth.users', $q$
    select t.tgenabled = 'O' and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'enforce_age_gate_on_user' and n.nspname = 'auth' and c.relname = 'users'
      and not t.tgisinternal
$q$);

select pg_temp.chk('02 clients cannot call the trigger function', $q$
    select has_function_privilege('supabase_auth_admin', 'public.enforce_age_gate_on_user()', 'execute')
       and not has_function_privilege('authenticated', 'public.enforce_age_gate_on_user()', 'execute')
       and not has_function_privilege('anon', 'public.enforce_age_gate_on_user()', 'execute')
       and not has_function_privilege('service_role', 'public.enforce_age_gate_on_user()', 'execute')
$q$);

-- ---- documented exemption: seed.sql / SQL fixtures insert as postgres
select pg_temp.chk('10 postgres may insert without age_gate (seed and fixtures)', $q$
    with ins as (
        insert into auth.users (id, aud, role, email)
        values ('a9e00000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
                'ag-pg@example.invalid')
        returning 1
    ) select count(*) = 1 from ins
$q$);

-- ---- the admin createUser path: supabase_auth_admin over dblink
select pg_temp.gotrue_check(
    '20 gotrue insert with no age_gate is refused (the admin createUser hole)',
    $i$
        insert into auth.users (id, aud, role, email)
        values ('a9e00000-0000-4000-8000-000000000020', 'authenticated', 'authenticated',
                'ag-admin-missing@example.invalid')
    $i$,
    '%Sign-up needs the age check first%'
);

select pg_temp.gotrue_check(
    '21 gotrue insert with a malformed country is refused the same way',
    $i$
        insert into auth.users (id, aud, role, email, raw_user_meta_data)
        values ('a9e00000-0000-4000-8000-000000000021', 'authenticated', 'authenticated',
                'ag-admin-bad@example.invalid',
                '{"age_gate":{"country":"Germany","min_age":16}}')
    $i$,
    '%Sign-up needs the age check first%'
);

select pg_temp.gotrue_check(
    '22 gotrue insert below the country age is refused, naming no age',
    $i$
        insert into auth.users (id, aud, role, email, raw_user_meta_data)
        values ('a9e00000-0000-4000-8000-000000000022', 'authenticated', 'authenticated',
                'ag-admin-young@example.invalid',
                '{"age_gate":{"country":"DE","min_age":13}}')
    $i$,
    '%Sorry, you % create a Cleffy account.%'
);

select pg_temp.chk('23 the under-age refusal names no digit', $q$
    select ok and (regexp_match(detail, 'Sorry, you .* create a Cleffy account\.'))[1] !~ '[0-9]'
    from t_results
    where name = '22 gotrue insert below the country age is refused, naming no age'
$q$);

-- ---- passing gates, including the student-provision and guest shapes
select pg_temp.gotrue_check(
    '30 gotrue insert with a self age_gate is allowed',
    $i$
        insert into auth.users (id, aud, role, email, raw_user_meta_data)
        values ('a9e00000-0000-4000-8000-000000000030', 'authenticated', 'authenticated',
                'ag-admin-ok@example.invalid',
                '{"age_gate":{"country":"US","min_age":13,"source":"self","v":1}}')
    $i$,
    'INSERT 0 1'
);

select pg_temp.gotrue_check(
    '31 gotrue insert with a teacher age_gate is allowed (student-provision)',
    $i$
        insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
        values ('a9e00000-0000-4000-8000-000000000031', 'authenticated', 'authenticated',
                'ag-admin-student@example.invalid',
                '{"user_type":"student"}',
                '{"display_name":"Sam","age_gate":{"country":"DE","min_age":16,"source":"teacher","v":1}}')
    $i$,
    'INSERT 0 1'
);

select pg_temp.gotrue_check(
    '32 gotrue insert of an anonymous guest with age_gate is allowed',
    $i$
        insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data)
        values ('a9e00000-0000-4000-8000-000000000032', 'authenticated', 'authenticated',
                null, true,
                '{"display_name":"Guest","age_gate":{"country":"GB","min_age":13,"source":"self","v":1}}')
    $i$,
    'INSERT 0 1'
);

select pg_temp.gotrue_check(
    '33 gotrue insert of an anonymous guest with no age_gate is refused',
    $i$
        insert into auth.users (id, aud, role, email, is_anonymous)
        values ('a9e00000-0000-4000-8000-000000000033', 'authenticated', 'authenticated',
                null, true)
    $i$,
    '%Sign-up needs the age check first%'
);

select extensions.dblink_exec('gotrue', 'rollback');
select extensions.dblink_disconnect('gotrue');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
