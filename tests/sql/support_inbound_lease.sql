-- Behaviour proof for 20261022110200_support_inbound_lease.sql: inbound
-- support mail is claimed under a reclaimable lease; a completed row is the
-- only duplicate; an interrupted delivery is resumed by the next one, whose
-- lease the old holder can no longer write through; a spent budget defers the
-- forward to the retry path; failures back off and give up at the attempt cap.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/launch_checkout_fixes.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/support_inbound_lease.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_claims (label text primary key, claim jsonb);
grant all on t_claims to anon, authenticated, service_role;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_message text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_message);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
create function pg_temp.as_auth() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
-- One webhook delivery's claim of `email`, remembered under `label`.
create function pg_temp.claim(p_label text, p_email text) returns jsonb language plpgsql as $f$
declare v jsonb;
begin
v := public.claim_support_message (p_email, '<m@x>', 'Ada <ada@example.test>', array['privacy@cleffy.io'],
    array['privacy@cleffy.io'], 'Delete my data', '[]'::jsonb, now());
insert into t_claims values (p_label, v) on conflict (label) do update set claim = excluded.claim;
return v;
end $f$;
create function pg_temp.holder(p_label text) returns uuid language sql as $f$ select (claim ->> 'holder')::uuid from t_claims where label = p_label $f$;
create function pg_temp.row_id(p_label text) returns uuid language sql as $f$ select (claim ->> 'id')::uuid from t_claims where label = p_label $f$;
create function pg_temp.msg(p_email text) returns public.support_messages language sql as $f$ select * from public.support_messages where resend_email_id = p_email $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.as_service();
-- Nothing else in this database is due while the proofs below run.
update public.support_messages set next_attempt_at = now() + interval '1 day' where status <> 'completed';

-- ===========================================================================
-- 1. Claim, duplicate, and an interrupted delivery resumed
-- ===========================================================================
select pg_temp.chk('01 the first delivery inserts the row and holds it',
$q$select (v ->> 'status') = 'claimed' and (v ->> 'inserted') = 'true'
   from (select pg_temp.claim('first', 'p3-lease-1') as v) x$q$);
select pg_temp.chk('02 ... processing, under a lease, one attempt',
$q$select status = 'processing' and lease_until > now() and attempts = 1
      and lease_holder = pg_temp.holder('first') from pg_temp.msg('p3-lease-1')$q$);
select pg_temp.chk('03 a duplicate delivery while it is held is told it is busy, not that it is done',
$q$select (pg_temp.claim('busy', 'p3-lease-1') ->> 'status') = 'busy'$q$);
select pg_temp.chk('04 only the holder can write the body',
$q$select not public.save_support_message_body (pg_temp.row_id('first'), gen_random_uuid(), 't', null)
      and public.save_support_message_body (pg_temp.row_id('first'), pg_temp.holder('first'), 'hello', '<p>hello</p>')$q$);
-- The first delivery dies here: its lease runs out.
update public.support_messages set lease_until = now() - interval '1 second' where resend_email_id = 'p3-lease-1';
select pg_temp.chk('05 the next delivery resumes the row (no second insert), with the body already stored',
$q$select (v ->> 'status') = 'claimed' and (v ->> 'inserted') = 'false' and (v ->> 'text_body') = 'hello'
      and (v ->> 'attempts')::int = 2 and (v ->> 'holder')::uuid <> pg_temp.holder('first')
   from (select pg_temp.claim('second', 'p3-lease-1') as v) x$q$);
select pg_temp.chk('06 the dead holder can no longer write the body or finish the row',
$q$select not public.save_support_message_body (pg_temp.row_id('first'), pg_temp.holder('first'), 'stale', null)
      and not public.finish_support_message (pg_temp.row_id('first'), pg_temp.holder('first'), 'stored')$q$);
select pg_temp.chk('07 the new holder finishes it: forwarded',
$q$select public.finish_support_message (pg_temp.row_id('second'), pg_temp.holder('second'), 'forwarded', null, null, 're_fwd_1')$q$);
select pg_temp.chk('08 ... completed, forwarded_at and the forward''s id recorded, lease released',
$q$select status = 'completed' and forwarded_at is not null and forward_resend_id = 're_fwd_1'
      and lease_holder is null and text_body = 'hello' from pg_temp.msg('p3-lease-1')$q$);
select pg_temp.chk('09 a delivery after that is the duplicate, and changes nothing',
$q$select (pg_temp.claim('late', 'p3-lease-1') ->> 'status') = 'duplicate'
      and (select attempts = 2 from pg_temp.msg('p3-lease-1'))$q$);
select pg_temp.chk('10 one row per Resend email id, however many deliveries',
$q$select count(*) = 1 from public.support_messages where resend_email_id = 'p3-lease-1'$q$);

-- ===========================================================================
-- 2. Budget spent: deferred, and the retry path picks it up
-- ===========================================================================
select pg_temp.claim('d', 'p3-lease-2');
select pg_temp.chk('20 a forward the budget cannot pay for is deferred',
$q$select public.finish_support_message (pg_temp.row_id('d'), pg_temp.holder('d'), 'deferred', null, 600)$q$);
select pg_temp.chk('21 ... stored as forward_deferred, not an attempt, due when the window reopens',
$q$select status = 'forward_deferred' and attempts = 0 and lease_holder is null
      and next_attempt_at between now() + interval '590 seconds' and now() + interval '610 seconds'
      and forward_error like 'forward deferred%' from pg_temp.msg('p3-lease-2')$q$);
select pg_temp.chk('22 the retry path does not take it before it is due',
$q$select not exists (select 1 from public.claim_due_support_messages (10) where resend_email_id = 'p3-lease-2')$q$);
update public.support_messages set next_attempt_at = now() - interval '1 second' where resend_email_id = 'p3-lease-2';
select pg_temp.chk('23 once due, the retry path takes it under a fresh lease',
$q$select count(*) = 1 from public.claim_due_support_messages (10) where resend_email_id = 'p3-lease-2'$q$);
select pg_temp.chk('24 ... so a second retry run cannot take it at the same time',
$q$select not exists (select 1 from public.claim_due_support_messages (10) where resend_email_id = 'p3-lease-2')$q$);
select pg_temp.chk('25 ... nor can a webhook redelivery',
$q$select (pg_temp.claim('redeliver', 'p3-lease-2') ->> 'status') = 'busy'$q$);
select pg_temp.chk('26 the retry finishes it',
$q$select public.finish_support_message (
    (select id from pg_temp.msg('p3-lease-2')), (select lease_holder from pg_temp.msg('p3-lease-2')), 'forwarded')
   and (select status = 'completed' from pg_temp.msg('p3-lease-2'))$q$);
select pg_temp.chk('27 a deferred row a webhook redelivery finds unleased is resumed by it',
$q$with c as (select pg_temp.claim('d3', 'p3-lease-3') as v)
   select public.finish_support_message ((v ->> 'id')::uuid, (v ->> 'holder')::uuid, 'deferred', null, 600)
      and (pg_temp.claim('d3b', 'p3-lease-3') ->> 'status') = 'claimed' from c$q$);

-- ===========================================================================
-- 3. Failures: back off, give up at the cap; final outcomes
-- ===========================================================================
select pg_temp.claim('r', 'p3-lease-4');
select pg_temp.chk('30 a failed attempt (body fetch, unknown send) stays processing and backs off',
$q$select public.finish_support_message (pg_temp.row_id('r'), pg_temp.holder('r'), 'retry', 'fetch 503')
      and (select status = 'processing' and lease_holder is null and next_attempt_at > now()
              and forward_error = 'fetch 503' from pg_temp.msg('p3-lease-4'))$q$);
update public.support_messages set attempts = public.support_message_max_attempts () - 1, next_attempt_at = now() - interval '1 second'
where resend_email_id = 'p3-lease-4';
select pg_temp.chk('31 the last attempt allowed is taken',
$q$select count(*) = 1 from public.claim_due_support_messages (10) where resend_email_id = 'p3-lease-4'$q$);
select pg_temp.chk('32 ... and when it fails too, the row is completed with its error',
$q$select public.finish_support_message ((select id from pg_temp.msg('p3-lease-4')),
          (select lease_holder from pg_temp.msg('p3-lease-4')), 'retry', 'fetch 503')
      and (select status = 'completed' and forward_error like 'gave up after 12 attempts%' from pg_temp.msg('p3-lease-4'))$q$);
select pg_temp.claim('s', 'p3-lease-5');
select pg_temp.chk('33 store-only is completed with no error',
$q$select public.finish_support_message (pg_temp.row_id('s'), pg_temp.holder('s'), 'stored')
      and (select status = 'completed' and forward_error is null and forwarded_at is null from pg_temp.msg('p3-lease-5'))$q$);
select pg_temp.claim('g', 'p3-lease-6');
select pg_temp.chk('34 the loop guard (or a forward rejected for good) is completed with its reason',
$q$select public.finish_support_message (pg_temp.row_id('g'), pg_temp.holder('g'), 'refused', 'loop guard')
      and (select status = 'completed' and forward_error = 'loop guard' from pg_temp.msg('p3-lease-6'))$q$);
select pg_temp.refused('35 an unknown outcome is refused',
$q$select public.finish_support_message (gen_random_uuid(), gen_random_uuid(), 'whatever')$q$, '22023');
select pg_temp.chk('36 a new row starts processing; the column default changed, and the state is constrained',
$q$select column_default like '''processing''%' from information_schema.columns
   where table_schema = 'public' and table_name = 'support_messages' and column_name = 'status'$q$);
select pg_temp.refused('37 ... to the three states',
$q$update public.support_messages set status = 'lost' where resend_email_id = 'p3-lease-5'$q$, '23514');
select pg_temp.chk('38 the retry tick runs (and with nothing due, does nothing)',
$q$select true from (select public.support_inbound_retry_tick ()) x$q$);
reset role;
select pg_temp.chk('39 ... and is scheduled',
$q$select exists (select 1 from cron.job where jobname = 'support-inbound-retry'
                  and command like '%support_inbound_retry_tick%')$q$);
select pg_temp.as_service();

-- ===========================================================================
-- 4. Service role only
-- ===========================================================================
select pg_temp.as_auth();
select pg_temp.refused('40 a signed-in client cannot claim a message',
$q$select public.claim_support_message ('x', null, 'x', '{}', '{}', null, '[]', now())$q$, '42501');
select pg_temp.refused('41 ... or claim due ones', $q$select count(*) from public.claim_due_support_messages (1)$q$, '42501');
select pg_temp.refused('42 ... or write a body', $q$select public.save_support_message_body (gen_random_uuid(), gen_random_uuid(), 'x', null)$q$, '42501');
select pg_temp.refused('43 ... or finish one', $q$select public.finish_support_message (gen_random_uuid(), gen_random_uuid(), 'stored')$q$, '42501');
select pg_temp.refused('44 ... or run the tick', $q$select public.support_inbound_retry_tick ()$q$, '42501');
select pg_temp.refused('45 ... or read support mail', $q$select count(*) from public.support_messages$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('46 anon cannot claim a message',
$q$select public.claim_support_message ('x', null, 'x', '{}', '{}', null, '[]', now())$q$, '42501');
select pg_temp.refused('47 ... or read support mail', $q$select count(*) from public.support_messages$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
