-- Behaviour proof for 20261022110200_support_inbound_lease.sql: inbound
-- support mail is claimed under a reclaimable lease; a completed row is the
-- only duplicate; an interrupted delivery is resumed by the next one, whose
-- lease the old holder can no longer write through; a spent budget defers the
-- forward to the retry path; failures back off and give up at the attempt cap.
--
-- And, for 20261022110300_support_inbound_retry_window.sql: every attempt pays
-- for itself (the claim no longer hands a retry a held budget), and no send is
-- made once 23 hours have passed since the first send attempt -- the row is
-- failed for review instead, and treated as finished by later deliveries.
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
update public.support_messages set next_attempt_at = now() + interval '1 day'
where status in ('processing', 'forward_deferred');

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
select pg_temp.chk('27 a deferred row is not jumped by a webhook redelivery before it is due',
$q$with c as (select pg_temp.claim('d3', 'p3-lease-3') as v)
   select public.finish_support_message ((v ->> 'id')::uuid, (v ->> 'holder')::uuid, 'deferred', null, 600)
      and (pg_temp.claim('d3b', 'p3-lease-3') ->> 'status') = 'busy' from c$q$);
select pg_temp.chk('28 ... nor counted as an attempt',
$q$select attempts = 0 from pg_temp.msg('p3-lease-3')$q$);
update public.support_messages set next_attempt_at = now() - interval '1 second' where resend_email_id = 'p3-lease-3';
select pg_temp.chk('29 once due, a redelivery resumes it',
$q$select (pg_temp.claim('d3c', 'p3-lease-3') ->> 'status') = 'claimed'$q$);

-- ===========================================================================
-- 3. Failures: back off, give up at the cap; final outcomes
-- ===========================================================================
select pg_temp.claim('r', 'p3-lease-4');
select pg_temp.chk('30 a failed attempt (body fetch, unknown send) stays processing and backs off',
$q$select public.finish_support_message (pg_temp.row_id('r'), pg_temp.holder('r'), 'retry', 'fetch 503')
      and (select status = 'processing' and lease_holder is null and next_attempt_at > now()
              and forward_error = 'fetch 503' from pg_temp.msg('p3-lease-4'))$q$);
select pg_temp.chk('30a a redelivery during the backoff is told to wait, and is not an attempt',
$q$select (pg_temp.claim('r-early', 'p3-lease-4') ->> 'status') = 'busy'
      and (select attempts = 1 from pg_temp.msg('p3-lease-4'))$q$);
update public.support_messages set attempts = public.support_message_max_attempts () - 1, next_attempt_at = now() - interval '1 second'
where resend_email_id = 'p3-lease-4';
select pg_temp.chk('31 the last attempt allowed is taken',
$q$select count(*) = 1 from public.claim_due_support_messages (10) where resend_email_id = 'p3-lease-4'$q$);
select pg_temp.chk('32 ... and when it fails too, the row is failed (for review) with its error',
$q$select public.finish_support_message ((select id from pg_temp.msg('p3-lease-4')),
          (select lease_holder from pg_temp.msg('p3-lease-4')), 'retry', 'fetch 503')
      and (select status = 'failed'
              and forward_error like 'gave up after ' || public.support_message_max_attempts () || ' attempts%'
           from pg_temp.msg('p3-lease-4'))$q$);
select pg_temp.claim('u', 'p3-lease-7');
select pg_temp.chk('33a a forward with an unknown outcome is retried, its kept reservation recorded',
$q$select public.finish_support_message (pg_temp.row_id('u'), pg_temp.holder('u'), 'retry', 'forward outcome unknown',
          null, null, true)
      and (select forward_budget_held from pg_temp.msg('p3-lease-7'))$q$);
update public.support_messages set next_attempt_at = now() - interval '1 second' where resend_email_id = 'p3-lease-7';
select pg_temp.chk('33b ... and the retry is NOT told to skip the budget: every attempt reserves its own',
$q$select (v ->> 'status') = 'claimed' and not (v ? 'budget_held')
   from (select pg_temp.claim('u2', 'p3-lease-7') as v) x$q$);
select pg_temp.chk('33c ... and a later retry without news keeps it; the forward clears it',
$q$select public.finish_support_message (pg_temp.row_id('u2'), pg_temp.holder('u2'), 'retry', 'fetch 503')
      and (select forward_budget_held from pg_temp.msg('p3-lease-7'))$q$);
update public.support_messages set next_attempt_at = now() - interval '1 second' where resend_email_id = 'p3-lease-7';
select pg_temp.chk('33d ... cleared once forwarded',
$q$with c as (select pg_temp.claim('u3', 'p3-lease-7') as v)
   select public.finish_support_message ((v ->> 'id')::uuid, (v ->> 'holder')::uuid, 'forwarded')
      and not (select forward_budget_held from pg_temp.msg('p3-lease-7')) from c$q$);
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
select pg_temp.refused('37 ... to the four states',
$q$update public.support_messages set status = 'lost' where resend_email_id = 'p3-lease-5'$q$, '23514');
select pg_temp.chk('38 the retry tick runs (and with nothing due, does nothing)',
$q$select true from (select public.support_inbound_retry_tick ()) x$q$);
reset role;
select pg_temp.chk('39 ... and is scheduled',
$q$select exists (select 1 from cron.job where jobname = 'support-inbound-retry'
                  and command like '%support_inbound_retry_tick%')$q$);
select pg_temp.as_service();

-- ===========================================================================
-- 5. The retry window: no send once Resend may have forgotten the key
-- ===========================================================================
select pg_temp.chk('50 the window is 23 hours, inside Resend''s 24-hour Idempotency-Key retention',
$q$select public.support_forward_retry_window () = interval '23 hours'$q$);
select pg_temp.claim('w', 'p3-window-1');
select pg_temp.chk('51 the first send attempt is allowed and records when it was made',
$q$select public.begin_support_forward (pg_temp.row_id('w'), pg_temp.holder('w')) = 'send'
      and (select first_send_attempt_at is not null from pg_temp.msg('p3-window-1'))$q$);
update public.support_messages set first_send_attempt_at = now() - interval '1 hour' where resend_email_id = 'p3-window-1';
select pg_temp.chk('52 a later attempt inside the window may send, and keeps the first time',
$q$select public.begin_support_forward (pg_temp.row_id('w'), pg_temp.holder('w')) = 'send'
      and (select first_send_attempt_at < now() - interval '59 minutes' from pg_temp.msg('p3-window-1'))$q$);
select pg_temp.chk('53 only the lease holder may begin a send',
$q$select public.begin_support_forward (pg_temp.row_id('w'), gen_random_uuid()) = 'lost'$q$);
select pg_temp.chk('54 an unknown outcome whose backoff lands inside the window is retried',
$q$select public.finish_support_message (pg_temp.row_id('w'), pg_temp.holder('w'), 'retry', 'forward outcome unknown',
          null, null, true)
      and (select status = 'processing' from pg_temp.msg('p3-window-1'))$q$);
update public.support_messages
set first_send_attempt_at = now() - interval '23 hours 1 second', next_attempt_at = now() - interval '1 second'
where resend_email_id = 'p3-window-1';
select pg_temp.chk('55 past the window, a claimed retry is told not to send',
$q$with c as (select pg_temp.claim('w2', 'p3-window-1') as v)
   select public.begin_support_forward ((v ->> 'id')::uuid, (v ->> 'holder')::uuid) = 'expired' from c$q$);
select pg_temp.chk('56 ... the row is failed for review, its lease released, its last error kept',
$q$select status = 'failed' and lease_holder is null and next_attempt_at is null and completed_at is not null
      and forward_error like 'retry window closed%forward outcome unknown%' and text_body is null
   from pg_temp.msg('p3-window-1')$q$);
select pg_temp.chk('57 a later delivery of a failed row is a duplicate, and is not an attempt',
$q$select (v ->> 'status') = 'duplicate' and (v ->> 'failed') = 'true'
      and (select attempts = 2 from pg_temp.msg('p3-window-1'))
   from (select pg_temp.claim('w3', 'p3-window-1') as v) x$q$);
select pg_temp.chk('58 the retry path never takes a failed row',
$q$select not exists (select 1 from public.claim_due_support_messages (50) where resend_email_id = 'p3-window-1')$q$);
select pg_temp.claim('w4', 'p3-window-2');
update public.support_messages set first_send_attempt_at = now() - interval '22 hours 59 minutes 30 seconds'
where resend_email_id = 'p3-window-2';
select pg_temp.chk('59 a retry whose next attempt would land past the window fails now instead of being scheduled',
$q$select public.finish_support_message (pg_temp.row_id('w4'), pg_temp.holder('w4'), 'retry', 'forward outcome unknown')
      and (select status = 'failed' and next_attempt_at is null and forward_error like 'retry window closed%'
           from pg_temp.msg('p3-window-2'))$q$);
select pg_temp.claim('w5', 'p3-window-3');
update public.support_messages set first_send_attempt_at = now() - interval '22 hours 50 minutes'
where resend_email_id = 'p3-window-3';
select pg_temp.chk('60 so does a budget deferral past the window, for a forward that was already attempted',
$q$select public.finish_support_message (pg_temp.row_id('w5'), pg_temp.holder('w5'), 'deferred', null, 3600)
      and (select status = 'failed' from pg_temp.msg('p3-window-3'))$q$);
select pg_temp.claim('w6', 'p3-window-4');
select pg_temp.chk('61 a forward never attempted has no window: a long deferral still just defers',
$q$select public.finish_support_message (pg_temp.row_id('w6'), pg_temp.holder('w6'), 'deferred', null, 172800)
      and (select status = 'forward_deferred' and first_send_attempt_at is null from pg_temp.msg('p3-window-4'))$q$);
select pg_temp.chk('62 a failed row cannot be written by a stale holder',
$q$select not public.save_support_message_body (pg_temp.row_id('w'), pg_temp.holder('w'), 'x', null)
      and not public.finish_support_message (pg_temp.row_id('w2'), pg_temp.holder('w2'), 'forwarded')$q$);
select pg_temp.chk('63 the retry tick ignores failed rows',
$q$select not exists (select 1 from public.support_messages where status = 'failed' and resend_email_id like 'p3-window-%'
                      and next_attempt_at is not null)$q$);

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
select pg_temp.refused('44a ... or begin a send', $q$select public.begin_support_forward (gen_random_uuid(), gen_random_uuid())$q$, '42501');
select pg_temp.refused('45 ... or read support mail', $q$select count(*) from public.support_messages$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('46 anon cannot claim a message',
$q$select public.claim_support_message ('x', null, 'x', '{}', '{}', null, '[]', now())$q$, '42501');
select pg_temp.refused('47 ... or read support mail', $q$select count(*) from public.support_messages$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
