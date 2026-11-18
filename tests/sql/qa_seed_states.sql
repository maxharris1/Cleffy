-- The QA seeded states (supabase/seed.sql, docs/qa-lane.md "Seeded states"):
-- each account is there in the state the doc names, and running the seed a
-- second time inserts and rewrites no row. LOCAL STACK only, after a seeded
-- start or reset. One transaction, ROLLED BACK; the last line is
-- `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.uid(p_email text) returns uuid language sql stable as $f$
    select id from auth.users where email = p_email $f$;
create function pg_temp.ent(p_email text) returns jsonb language sql stable as $f$
    select public.resolve_entitlements (pg_temp.uid(p_email)) $f$;
create function pg_temp.seeded_rows() returns table (tbl text, row_xmin text, row_text text) language sql stable as $f$
    select 'auth.users', xmin::text, t::text from auth.users t
    union all select 'auth.identities', xmin::text, t::text from auth.identities t
    union all select 'storage.buckets', xmin::text, t::text from storage.buckets t
    union all select 'public.documents', xmin::text, t::text from public.documents t
    union all select 'public.document_members', xmin::text, t::text from public.document_members t
    union all select 'public.document_favorites', xmin::text, t::text from public.document_favorites t
    union all select 'public.billing_customers', xmin::text, t::text from public.billing_customers t
    union all select 'public.subscriptions', xmin::text, t::text from public.subscriptions t
    union all select 'vault.secrets', xmin::text, t.name from vault.secrets t $f$;

select pg_temp.chk('01 each QA account signs in with the documented password and has its email identity', $q$
    select count(*) = 4 from auth.users u
    where u.email in ('qa-new@cleffy.test', 'qa-one-score@cleffy.test', 'qa-subscribed@cleffy.test', 'qa-lapsed@cleffy.test')
      and u.email_confirmed_at is not null
      and u.encrypted_password = extensions.crypt('cleffy-local-test', u.encrypted_password)
      and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')$q$);

select pg_temp.chk('02 qa-new: free plan, no scores, no subscription', $q$
    select pg_temp.ent('qa-new@cleffy.test') ->> 'tier' = 'free'
       and not exists (select 1 from public.documents where owner_id = pg_temp.uid('qa-new@cleffy.test'))
       and not exists (select 1 from public.subscriptions where user_id = pg_temp.uid('qa-new@cleffy.test'))$q$);

select pg_temp.chk('03 qa-one-score: free plan, exactly one active processed score it owns, no subscription', $q$
    select pg_temp.ent('qa-one-score@cleffy.test') ->> 'tier' = 'free'
       and (select count(*) = 1 and bool_and(d.page_count > 0 and d.archived_at is null and m.role = 'owner')
            from public.documents d
            join public.document_members m on m.document_id = d.id and m.user_id = d.owner_id
            where d.owner_id = pg_temp.uid('qa-one-score@cleffy.test'))
       and not exists (select 1 from public.subscriptions where user_id = pg_temp.uid('qa-one-score@cleffy.test'))$q$);

select pg_temp.chk('04 qa-subscribed: an active Personal subscription entitles it, no scores', $q$
    select pg_temp.ent('qa-subscribed@cleffy.test') ->> 'tier' = 'personal'
       and pg_temp.ent('qa-subscribed@cleffy.test') ->> 'source' = 'subscription'
       and pg_temp.ent('qa-subscribed@cleffy.test') ->> 'status' = 'active'
       and not exists (select 1 from public.documents where owner_id = pg_temp.uid('qa-subscribed@cleffy.test'))$q$);

select pg_temp.chk('05 qa-lapsed: its subscription is canceled and ended, so it is back on the free plan, no scores', $q$
    select pg_temp.ent('qa-lapsed@cleffy.test') ->> 'tier' = 'free'
       and pg_temp.ent('qa-lapsed@cleffy.test') ->> 'source' = 'none'
       and exists (select 1 from public.subscriptions
                   where user_id = pg_temp.uid('qa-lapsed@cleffy.test')
                     and status = 'canceled' and ended_at < now())
       and not exists (select 1 from public.documents where owner_id = pg_temp.uid('qa-lapsed@cleffy.test'))$q$);

create temp table t_before as select * from pg_temp.seeded_rows();
\ir ../../supabase/seed.sql
create temp table t_after as select * from pg_temp.seeded_rows();

select pg_temp.chk('06 seeding a second time inserts, deletes and rewrites no row', $q$
    select not exists (select * from t_before except select * from t_after)
       and not exists (select * from t_after except select * from t_before)
       and (select count(*) from t_before) = (select count(*) from t_after)$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
