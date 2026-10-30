-- District seats (migration 20261020180400_district_seat_overrides.sql): an
-- admin-set teacher-seat override above the Academy cap of 5, tied to the
-- studio owner's Stripe Invoicing (send_invoice) subscription, honoured by
-- studios_enforce_seat_limit, never reset by the webhook's subscription writes,
-- and every change written to studio_seat_override_log.
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as (p_role text) returns void language plpgsql as $$
begin
    perform set_config('role', p_role, true);
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
end;
$$;

create function pg_temp.act_as_user (p_user uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_build_object('role', 'authenticated', 'sub', p_user, 'is_anonymous', false)::text,
        true
    );
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default 1) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, v_rows = p_rows, 'touched ' || v_rows || ' row(s)');
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_message_like text default null)
returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (
            p_name,
            v_state = p_state and (p_message_like is null or v_msg like p_message_like),
            v_state || ' ' || v_msg
        );
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

-- The webhook's write, exactly as stripe-webhook makes it: take the lease, write
-- under it, give it back. Run as the service role.
create function pg_temp.webhook_write (
    p_sub text,
    p_user uuid,
    p_tier text,
    p_status text,
    p_period_end timestamptz,
    p_method text,
    p_stamp timestamptz
) returns text language plpgsql as $$
declare
    v_holder uuid;
    v_answer text;
begin
    v_holder := public.claim_subscription_write (p_sub, interval '5 minutes');
    v_answer := public.write_subscription_under_lock (
        v_holder, p_sub, p_user, 'test', p_tier, p_status, 'price_district_custom',
        p_period_end, false, p_stamp, p_method
    );
    perform public.release_subscription_write (p_sub, v_holder);
    return v_answer;
end;
$$;

grant execute on function pg_temp.webhook_write (text, uuid, text, text, timestamptz, text, timestamptz) to public;

-- Throwaway accounts. 'd15' for district seats. a1 owns the district studio,
-- a2 is somebody else, b1..b9 are teachers to seat.
insert into auth.users (id, aud, role, email)
select ('d1500000-0000-4000-8000-0000000000' || suffix)::uuid, 'authenticated', 'authenticated',
       'd15-' || suffix || '@example.invalid'
from unnest(array['a1', 'a2', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) as suffix;

insert into public.studios (id, owner_id, name)
values
    ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-0000000000a1', 'District'),
    ('d1500000-0000-4000-8000-00000000c002', 'd1500000-0000-4000-8000-0000000000a2', 'Other academy');

-- ===========================================================================
-- The webhook records collection_method
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'a send_invoice district subscription is written through the webhook path',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '10 minutes') = 'written'$q$
);

select pg_temp.holds (
    'a charge_automatically Academy subscription is written for the other owner',
    $q$select pg_temp.webhook_write ('sub_d15_card', 'd1500000-0000-4000-8000-0000000000a2', 'academy',
           'active', now() + interval '1 month', 'charge_automatically', now() - interval '10 minutes') = 'written'$q$
);

select pg_temp.holds (
    'the district row records send_invoice',
    $q$select collection_method = 'send_invoice' from public.subscriptions
       where stripe_subscription_id = 'sub_d15_district'$q$
);

select pg_temp.holds (
    'the district owner is entitled to Academy by their own subscription',
    $q$select public.get_entitlements ('d1500000-0000-4000-8000-0000000000a1') ->> 'tier' = 'academy'
          and public.get_entitlements ('d1500000-0000-4000-8000-0000000000a1') ->> 'source' = 'subscription'$q$
);

select pg_temp.act_as_server ();

-- ===========================================================================
-- Without an override the studio is capped at 5
-- ===========================================================================
select pg_temp.holds (
    'the effective limit is the Academy cap of 5 before any override',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5$q$
);

select pg_temp.allowed (
    'the owner seats four teachers (owner + 4 = 5)',
    $q$insert into public.studio_members (studio_id, user_id)
       select 'd1500000-0000-4000-8000-00000000c001', ('d1500000-0000-4000-8000-0000000000' || s)::uuid
       from unnest(array['b1', 'b2', 'b3', 'b4']) as s$q$,
    4
);

select pg_temp.refused (
    'a fifth teacher is refused at the cap',
    $q$insert into public.studio_members (studio_id, user_id)
       values ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-0000000000b5')$q$,
    'P0001',
    'seat_limit_reached'
);

-- ===========================================================================
-- Admin-only
-- ===========================================================================
select pg_temp.act_as_user ('d1500000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'the studio owner cannot set their own override',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 50,
           'sub_d15_district', 'owner')$q$,
    '42501'
);

select pg_temp.refused (
    'nor clear one',
    $q$select public.admin_clear_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 'owner')$q$,
    '42501'
);

select pg_temp.refused (
    'nor read the override table',
    $q$select count(*) from public.studio_seat_overrides$q$,
    '42501'
);

select pg_temp.refused (
    'nor write it directly',
    $q$insert into public.studio_seat_overrides (studio_id, seat_limit, stripe_subscription_id, updated_by)
       values ('d1500000-0000-4000-8000-00000000c001', 50, 'sub_d15_district', 'owner')$q$,
    '42501'
);

select pg_temp.refused (
    'nor read the change log',
    $q$select count(*) from public.studio_seat_override_log$q$,
    '42501'
);

select pg_temp.refused (
    'nor raise studios.seat_limit itself',
    $q$update public.studios set seat_limit = 50 where id = 'd1500000-0000-4000-8000-00000000c001'$q$,
    '42501'
);

select pg_temp.refused (
    'nor call the unchecked effective-limit function',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001')$q$,
    '42501'
);

select pg_temp.act_as ('anon');

select pg_temp.refused (
    'anon cannot set an override',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 50,
           'sub_d15_district', 'anon')$q$,
    '42501'
);

-- A service-role grant reached with a user's identity in the JWT is still
-- refused: the function checks, not only the grant.
select pg_temp.act_as ('service_role');

select set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role', 'sub', 'd1500000-0000-4000-8000-0000000000a1')::text,
    true
);

select pg_temp.refused (
    'a user identity is refused even where EXECUTE is held',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 50,
           'sub_d15_district', 'someone')$q$,
    '42501'
);

select pg_temp.act_as ('service_role');

-- ===========================================================================
-- What the admin function refuses, so an override never silently does nothing
-- ===========================================================================
select pg_temp.refused (
    'an override at or below the Academy cap is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 5,
           'sub_d15_district', 'max')$q$,
    '22023'
);

select pg_temp.refused (
    'an override with no actor is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 8,
           'sub_d15_district', '  ')$q$,
    '22023'
);

select pg_temp.refused (
    'a subscription the webhook has not recorded is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 8,
           'sub_d15_typo', 'max')$q$,
    'P0002',
    '%not recorded yet%'
);

select pg_temp.refused (
    'another user''s subscription is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 8,
           'sub_d15_card', 'max')$q$,
    '22023',
    '%belongs to another user%'
);

select pg_temp.refused (
    'a charge_automatically (Checkout) subscription is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c002', 8,
           'sub_d15_card', 'max')$q$,
    '22023',
    '%not a send_invoice%'
);

select pg_temp.refused (
    'an unknown studio is refused',
    $q$select public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c0ff', 8,
           'sub_d15_district', 'max')$q$,
    'P0002'
);

select pg_temp.holds (
    'nothing refused above left an override or a log row behind',
    $q$select (select count(*) from public.studio_seat_overrides
               where studio_id in ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-00000000c002')) = 0
          and (select count(*) from public.studio_seat_override_log
               where studio_id in ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-00000000c002')) = 0$q$
);

-- ===========================================================================
-- Setting it: honoured by the seat trigger, logged
-- ===========================================================================
select pg_temp.holds (
    'the admin sets 8 seats against the district subscription',
    $q$select (public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 8,
           'sub_d15_district', 'max', 'Contract D-1, 8 teachers') ->> 'effective_seat_limit')::int = 8$q$
);

select pg_temp.holds (
    'the change log records the set, with actor and reason',
    $q$select action = 'set' and old_seat_limit is null and new_seat_limit = 8
              and new_stripe_subscription_id = 'sub_d15_district'
              and actor = 'max' and reason = 'Contract D-1, 8 teachers'
       from public.studio_seat_override_log
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.act_as_server ();

select pg_temp.allowed (
    'three more teachers fit under the override (owner + 7 = 8)',
    $q$insert into public.studio_members (studio_id, user_id)
       select 'd1500000-0000-4000-8000-00000000c001', ('d1500000-0000-4000-8000-0000000000' || s)::uuid
       from unnest(array['b5', 'b6', 'b7']) as s$q$,
    3
);

select pg_temp.refused (
    'the next one is refused at the override, and the error names it',
    $q$insert into public.studio_members (studio_id, user_id)
       values ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-0000000000b8')$q$,
    'P0001',
    'seat_limit_reached'
);

select pg_temp.holds (
    'the other academy is still capped at 5',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c002') = 5$q$
);

-- The client read: owner and members may ask, nobody else.
select pg_temp.act_as_user ('d1500000-0000-4000-8000-0000000000a1');

select pg_temp.holds (
    'the owner reads 8 seats through studio_seat_limit',
    $q$select public.studio_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 8$q$
);

select pg_temp.act_as_user ('d1500000-0000-4000-8000-0000000000b1');

select pg_temp.holds (
    'a seated teacher reads it too',
    $q$select public.studio_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 8$q$
);

select pg_temp.act_as_user ('d1500000-0000-4000-8000-0000000000a2');

select pg_temp.refused (
    'a stranger cannot learn the district''s size',
    $q$select public.studio_seat_limit ('d1500000-0000-4000-8000-00000000c001')$q$,
    '42501'
);

-- ===========================================================================
-- The webhook never resets it
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'a renewal (period moved, from a webhook that sends no method) is written',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '2 years', null, now() - interval '9 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and keeps send_invoice, the override row and the effective 8',
    $q$select (select collection_method from public.subscriptions
               where stripe_subscription_id = 'sub_d15_district') = 'send_invoice'
          and (select seat_limit from public.studio_seat_overrides
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 8
          and public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 8$q$
);

select pg_temp.holds (
    'an unpaid invoice past its due date (past_due) is written',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'free',
           'past_due', now() + interval '2 years', 'send_invoice', now() - interval '8 minutes') = 'written'$q$
);

select pg_temp.holds (
    'while past due the studio is back on 5, but the override is kept',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5
          and (select seat_limit from public.studio_seat_overrides
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 8$q$
);

select pg_temp.act_as_server ();

select pg_temp.refused (
    'and no one new can be seated meanwhile',
    $q$insert into public.studio_members (studio_id, user_id)
       values ('d1500000-0000-4000-8000-00000000c001', 'd1500000-0000-4000-8000-0000000000b8')$q$,
    'P0001',
    'seat_limit_reached'
);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the district pays, the subscription is active again',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '2 years', 'send_invoice', now() - interval '7 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and the 8 seats come back with nobody re-setting them',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 8$q$
);

-- Each write and the read after it are separate statements: the effective limit
-- is a STABLE function, so inside one statement it sees that statement's
-- snapshot, from before the write.
select pg_temp.holds (
    'a period that has ended is written',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() - interval '1 minute', 'send_invoice', now() - interval '6 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and stops honouring it',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5$q$
);

select pg_temp.holds (
    'the contract is cancelled',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'free',
           'canceled', now() + interval '2 years', 'send_invoice', now() - interval '5 minutes') = 'written'$q$
);

select pg_temp.holds (
    'a cancelled contract is back on 5; the webhook logged nothing and removed nothing',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5
          and (select count(*) from public.studio_seat_overrides
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 1
          and (select count(*) from public.studio_seat_override_log
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 1$q$
);

select pg_temp.holds (
    'a switch to charge_automatically is written',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '2 years', 'charge_automatically', now() - interval '4 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and stops honouring it too',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5$q$
);

select pg_temp.holds (
    'switching back to send_invoice is written',
    $q$select pg_temp.webhook_write ('sub_d15_district', 'd1500000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '2 years', 'send_invoice', now() - interval '3 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and restores it',
    $q$select public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 8$q$
);

-- ===========================================================================
-- Changing and clearing it
-- ===========================================================================
select pg_temp.holds (
    'the admin raises it to 12',
    $q$select (public.admin_set_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 12,
           'sub_d15_district', 'max', 'Contract D-1 amendment') ->> 'effective_seat_limit')::int = 12$q$
);

select pg_temp.holds (
    'the change log records old and new',
    $q$select action = 'changed' and old_seat_limit = 8 and new_seat_limit = 12
              and actor = 'max' and reason = 'Contract D-1 amendment'
       from public.studio_seat_override_log
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'
       order by id desc limit 1$q$
);

select pg_temp.holds (
    'the admin clears it',
    $q$select public.admin_clear_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 'max',
           'Contract ended')$q$
);

select pg_temp.holds (
    'the clear is logged and the studio is back on 5',
    $q$select action = 'cleared' and old_seat_limit = 12 and actor = 'max' and reason = 'Contract ended'
              and public.studio_effective_seat_limit ('d1500000-0000-4000-8000-00000000c001') = 5
       from public.studio_seat_override_log
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'
       order by id desc limit 1$q$
);

select pg_temp.holds (
    'clearing again finds nothing to clear',
    $q$select not public.admin_clear_studio_seat_override ('d1500000-0000-4000-8000-00000000c001', 'max')$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'members seated above the cap keep their seats when it lapses',
    $q$select count(*) = 7 from public.studio_members
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'$q$
);

-- A hand-run statement in the SQL editor is logged too.
select pg_temp.allowed (
    'a direct insert by the database owner is allowed',
    $q$insert into public.studio_seat_overrides (studio_id, seat_limit, stripe_subscription_id, reason, updated_by)
       values ('d1500000-0000-4000-8000-00000000c001', 20, 'sub_d15_district', 'by hand', 'max (sql editor)')$q$
);

select pg_temp.holds (
    'and logged with the row''s own actor and reason',
    $q$select action = 'set' and new_seat_limit = 20 and actor = 'max (sql editor)' and reason = 'by hand'
       from public.studio_seat_override_log
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'
       order by id desc limit 1$q$
);

select pg_temp.refused (
    'the table itself refuses an override at or below 5',
    $q$update public.studio_seat_overrides set seat_limit = 5
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'$q$,
    '23514'
);

select pg_temp.refused (
    'and a subscription id that does not exist',
    $q$update public.studio_seat_overrides set stripe_subscription_id = 'sub_d15_typo'
       where studio_id = 'd1500000-0000-4000-8000-00000000c001'$q$,
    '23503'
);

-- The studio going (its owner deleting the account) takes the override with it,
-- logs that, and keeps the history.
select pg_temp.allowed (
    'the district studio is deleted',
    $q$delete from public.studios where id = 'd1500000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'the override went with it, the clear was logged, and the history is kept',
    $q$select (select count(*) from public.studio_seat_overrides
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 0
          and (select action from public.studio_seat_override_log
               where studio_id = 'd1500000-0000-4000-8000-00000000c001'
               order by id desc limit 1) = 'cleared'
          and (select count(*) from public.studio_seat_override_log
               where studio_id = 'd1500000-0000-4000-8000-00000000c001') = 5$q$
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
