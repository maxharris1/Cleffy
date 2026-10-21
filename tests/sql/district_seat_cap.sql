-- District seat cap (migration 20261020180500_district_seat_cap_and_grace.sql):
-- resolve_entitlements() enforces a studio's effective seat limit, so the seats
-- past it -- after an override is lowered or cleared, after a district's invoice
-- grace runs out, or after a district moves to ordinary Academy -- are read-only
-- (view and export, nothing created, scores archived so no marks), oldest seats
-- first unless the owner picked; nothing is deleted, and paying again restores
-- every seat. Also: a send_invoice subscription keeps full access for 30 days
-- past due (or an admin's extension), and district_billing.contract_ends_at
-- follows Stripe unless an admin pins it.
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
    p_stamp timestamptz,
    p_cancelling boolean default false,
    p_ended_at timestamptz default null
) returns text language plpgsql as $$
declare
    v_holder uuid;
    v_answer text;
begin
    v_holder := public.claim_subscription_write (p_sub, interval '5 minutes');
    v_answer := public.write_subscription_under_lock (
        v_holder, p_sub, p_user, 'test', p_tier, p_status, 'price_district_custom',
        p_period_end, p_cancelling, p_stamp, p_method, p_ended_at
    );
    perform public.release_subscription_write (p_sub, v_holder);
    return v_answer;
end;
$$;

grant execute on function pg_temp.webhook_write (text, uuid, text, text, timestamptz, text, timestamptz, boolean, timestamptz)
to public;

-- Is this teacher on a full Academy seat, read-only, or neither?
create function pg_temp.seat (p_user text) returns text language sql as $$
    select case
        when (e ->> 'seat_read_only')::boolean then 'read_only'
        when e ->> 'tier' = 'academy' and e ->> 'source' = 'studio_member' then 'academy'
        else e ->> 'tier'
    end
    from (select public.resolve_entitlements (('d1600000-0000-4000-8000-0000000000' || p_user)::uuid) as e) r;
$$;

-- The seat of every member, b1..b9, in order: 'A' academy, 'R' read-only, 'f' free.
create function pg_temp.seats () returns text language sql as $$
    select string_agg(
        case pg_temp.seat (s) when 'academy' then 'A' when 'read_only' then 'R' when 'free' then 'f' else '?' end,
        '' order by s
    )
    from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) as s;
$$;

-- Each member's archived score count, b1..b9, as digits.
create function pg_temp.archived () returns text language sql as $$
    select string_agg(
        (select count(*) from public.documents d
         where d.owner_id = ('d1600000-0000-4000-8000-0000000000' || s)::uuid and d.archived_at is not null)::text,
        '' order by s
    )
    from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) as s;
$$;

grant execute on function pg_temp.seat (text) to public;
grant execute on function pg_temp.seats () to public;
grant execute on function pg_temp.archived () to public;

-- Throwaway accounts. 'd16' for the district seat cap. a1 owns the district,
-- a2 an ordinary card-paid Academy, b1..b9 are teachers seated oldest first.
insert into auth.users (id, aud, role, email)
select ('d1600000-0000-4000-8000-0000000000' || suffix)::uuid, 'authenticated', 'authenticated',
       'd16-' || suffix || '@example.invalid'
from unnest(array['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) as suffix;

insert into public.studios (id, owner_id, name)
values
    ('d1600000-0000-4000-8000-00000000c001', 'd1600000-0000-4000-8000-0000000000a1', 'District'),
    ('d1600000-0000-4000-8000-00000000c002', 'd1600000-0000-4000-8000-0000000000a2', 'Card academy'),
    ('d1600000-0000-4000-8000-00000000c003', 'd1600000-0000-4000-8000-0000000000a3', 'Late district'),
    ('d1600000-0000-4000-8000-00000000c004', 'd1600000-0000-4000-8000-0000000000a4', 'Renewing district');

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the district subscription is recorded (send_invoice, Academy, active)',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '60 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and the webhook made it a billing record for the owner''s studio, with no contract end',
    $q$select stripe_subscription_id = 'sub_d16_district' and contract_ends_at is null
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'an override of 10 seats is set',
    $q$select (public.admin_set_studio_seat_override (
           'd1600000-0000-4000-8000-00000000c001', 10, 'sub_d16_district', 'test', 'Contract #16'
       ) ->> 'effective_seat_limit')::int = 10$q$
);

select pg_temp.act_as_server ();

-- Nine teachers, seated a minute apart (b1 the oldest), each with two scores.
insert into public.studio_members (studio_id, user_id, created_at)
select 'd1600000-0000-4000-8000-00000000c001', ('d1600000-0000-4000-8000-0000000000b' || i)::uuid,
       now() - interval '1 day' + i * interval '1 minute'
from generate_series(1, 9) as i;

insert into public.documents (id, owner_id, title, storage_path)
select ('d1600000-0000-4000-8000-000000000' || i || '0' || j)::uuid, ('d1600000-0000-4000-8000-0000000000b' || i)::uuid,
       'Score ' || i || '.' || j, 'd1600000-0000-4000-8000-000000000' || i || '0' || j || '/original.pdf'
from generate_series(1, 9) as i, generate_series(1, 2) as j;

-- ===========================================================================
-- Inside the limit: everyone is a full seat
-- ===========================================================================
select pg_temp.holds ('all nine seats are full Academy seats at 10', $q$select pg_temp.seats () = 'AAAAAAAAA'$q$);

select pg_temp.holds ('and nothing is archived', $q$select pg_temp.archived () = '000000000'$q$);

select pg_temp.holds (
    'a full seat carries seat_read_only = false',
    $q$select (public.resolve_entitlements ('d1600000-0000-4000-8000-0000000000b9') ->> 'seat_read_only')::boolean = false$q$
);

-- ===========================================================================
-- Override lowered: the newest seats past it go read-only
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the override is lowered to 6',
    $q$select (public.admin_set_studio_seat_override (
           'd1600000-0000-4000-8000-00000000c001', 6, 'sub_d16_district', 'test', 'Contract amended'
       ) ->> 'effective_seat_limit')::int = 6$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'the five oldest stay full; the four newest are read-only',
    $q$select pg_temp.seats () = 'AAAAARRRR'$q$
);

select pg_temp.holds (
    'a read-only seat is not Academy: tier free, zero on everything created, unlimited export',
    $q$select e ->> 'tier' = 'free' and e ->> 'source' = 'studio_member'
          and (e -> 'limits' ->> 'cloud_scores')::int = 0
          and (e -> 'limits' ->> 'omr_runs')::int = 0
          and (e -> 'limits' ->> 'smart_imports')::int = 0
          and (e -> 'limits' ->> 'vision_reads')::int = 0
          and (e -> 'limits' ->> 'students')::int = 0
          and (e -> 'limits' ->> 'pdf_exports')::int = -1
       from (select public.resolve_entitlements ('d1600000-0000-4000-8000-0000000000b9') as e) r$q$
);

select pg_temp.holds (
    'the read-only seats'' scores are archived at once (no edits), the full seats'' are not',
    $q$select pg_temp.archived () = '000002222'$q$
);

select pg_temp.holds (
    'nothing was deleted: every score and every seat is still there',
    $q$select (select count(*) from public.documents d where d.owner_id::text like 'd1600000-0000-4000-8000-0000000000b%') = 18
          and (select count(*) from public.studio_members sm
               where sm.studio_id = 'd1600000-0000-4000-8000-00000000c001') = 9$q$
);

select pg_temp.holds (
    'annotation writes on a read-only seat''s score are what RLS refuses (document_is_archived)',
    $q$select public.document_is_archived ('d1600000-0000-4000-8000-000000000901')
          and not public.document_is_archived ('d1600000-0000-4000-8000-000000000101')$q$
);

select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000b9');

select pg_temp.holds (
    'a read-only teacher can still open (view) their own score',
    $q$select count(*) = 1 from public.documents where id = 'd1600000-0000-4000-8000-000000000901'$q$
);

select pg_temp.holds (
    'and their export claim is unlimited',
    $q$select (public.claim_pdf_export ('d1600000-0000-4000-8000-000000000901') ->> 'ok')::boolean$q$
);

select pg_temp.refused (
    'but cannot upload a new score',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('d1600000-0000-4000-8000-000000000999', 'd1600000-0000-4000-8000-0000000000b9', 'New',
               'd1600000-0000-4000-8000-000000000999/original.pdf')$q$,
    'P0001',
    'limit_reached'
);

select pg_temp.refused (
    'nor un-archive one',
    $q$update public.documents set archived_at = null where id = 'd1600000-0000-4000-8000-000000000901'$q$,
    'P0001',
    'limit_reached'
);

select pg_temp.act_as_server ();

select pg_temp.refused (
    'and the studio takes no new invites while over its limit',
    $q$insert into public.studio_members (studio_id, user_id)
       values ('d1600000-0000-4000-8000-00000000c001', 'd1600000-0000-4000-8000-0000000000a2')$q$,
    'P0001',
    'seat_limit_reached'
);

select pg_temp.holds (
    'studio_seat_states agrees with studio_seat_is_active for every member',
    $q$select bool_and(s.active = public.studio_seat_is_active ('d1600000-0000-4000-8000-00000000c001', s.user_id))
       from public.studio_seat_states ('d1600000-0000-4000-8000-00000000c001') s$q$
);

-- ===========================================================================
-- The owner picks which seats stay active
-- ===========================================================================
select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000a1');

select pg_temp.holds (
    'the owner sees which seats are active and which are read-only',
    $q$select count(*) filter (where active) = 5 and count(*) filter (where not active) = 4
       from public.studio_seat_status ('d1600000-0000-4000-8000-00000000c001')$q$
);

select pg_temp.holds (
    'the owner keeps b9 and b8 active',
    $q$select public.studio_set_active_seats ('d1600000-0000-4000-8000-00000000c001',
           array['d1600000-0000-4000-8000-0000000000b9', 'd1600000-0000-4000-8000-0000000000b8']::uuid[]) >= 0$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'kept seats rank first, then the oldest: b1-b3, b8, b9 full; b4-b7 read-only',
    $q$select pg_temp.seats () = 'AAARRRRAA'$q$
);

select pg_temp.holds (
    'and the archive follows the pick: b8 and b9 get their scores back, b4 and b5 lose theirs',
    $q$select pg_temp.archived () = '000222200'$q$
);

select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'keeping more seats than the limit leaves room for is refused',
    $q$select public.studio_set_active_seats ('d1600000-0000-4000-8000-00000000c001',
           array(select ('d1600000-0000-4000-8000-0000000000b' || i)::uuid from generate_series(1, 6) as i))$q$,
    '22023',
    'only 5 seats can be active%'
);

select pg_temp.refused (
    'keeping someone who is not a member is refused',
    $q$select public.studio_set_active_seats ('d1600000-0000-4000-8000-00000000c001',
           array['d1600000-0000-4000-8000-0000000000a2']::uuid[])$q$,
    '22023'
);

select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000b1');

select pg_temp.refused (
    'a member cannot choose the active seats',
    $q$select public.studio_set_active_seats ('d1600000-0000-4000-8000-00000000c001',
           array['d1600000-0000-4000-8000-0000000000b1']::uuid[])$q$,
    '42501'
);

select pg_temp.refused (
    'nor read the seat list',
    $q$select count(*) from public.studio_seat_status ('d1600000-0000-4000-8000-00000000c001')$q$,
    '42501'
);

-- ===========================================================================
-- Override cleared: back to Academy's 5
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the override is cleared',
    $q$select public.admin_clear_studio_seat_override ('d1600000-0000-4000-8000-00000000c001', 'test', 'Cleared')$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'four full seats remain (b8 and b9 kept, then b1 and b2); five are read-only',
    $q$select pg_temp.seats () = 'AARRRRRAA'$q$
);

select pg_temp.holds ('the archive follows', $q$select pg_temp.archived () = '002222200'$q$);

-- ===========================================================================
-- Restoring the override restores every seat
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the override of 10 is set again',
    $q$select (public.admin_set_studio_seat_override (
           'd1600000-0000-4000-8000-00000000c001', 10, 'sub_d16_district', 'test', 'Renewed'
       ) ->> 'effective_seat_limit')::int = 10$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds ('every seat is full again', $q$select pg_temp.seats () = 'AAAAAAAAA'$q$);

select pg_temp.holds ('and every score is back', $q$select pg_temp.archived () = '000000000'$q$);

-- ===========================================================================
-- Past due: 30 days of full access, then the lapse rules
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the invoice goes past due (the webhook keeps tier academy for send_invoice)',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'past_due', now() + interval '1 year', 'send_invoice', now() - interval '50 minutes') = 'written'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'past_due_since is stamped',
    $q$select past_due_since = now() from public.subscriptions where stripe_subscription_id = 'sub_d16_district'$q$
);

select pg_temp.holds (
    'inside the grace period the override still counts and every seat is full',
    $q$select public.studio_effective_seat_limit ('d1600000-0000-4000-8000-00000000c001') = 10
          and pg_temp.seats () = 'AAAAAAAAA'$q$
);

select pg_temp.holds (
    'and the owner is still on Academy',
    $q$select public.resolve_entitlements ('d1600000-0000-4000-8000-0000000000a1') ->> 'tier' = 'academy'$q$
);

select pg_temp.holds (
    'a later past-due delivery does not restart the clock',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'unpaid', now() + interval '1 year', 'send_invoice', now() - interval '49 minutes') = 'written'$q$
);

-- The clock, moved: the invoice went past due 29 days ago, then 31.
update public.subscriptions set past_due_since = now() - interval '29 days'
where stripe_subscription_id = 'sub_d16_district';

select pg_temp.holds (
    'day 29: still full access',
    $q$select public.studio_effective_seat_limit ('d1600000-0000-4000-8000-00000000c001') = 10
          and pg_temp.seats () = 'AAAAAAAAA'$q$
);

-- Only the clock moves on day 31: nothing writes the row, so no trigger runs.
set local session_replication_role = replica;

update public.subscriptions set past_due_since = now() - interval '31 days'
where stripe_subscription_id = 'sub_d16_district';

set local session_replication_role = origin;

select pg_temp.holds (
    'day 31: the override has lapsed and the seats past 5 are read-only (the owner''s pick still holds)',
    $q$select public.studio_effective_seat_limit ('d1600000-0000-4000-8000-00000000c001') = 5
          and pg_temp.seats () = 'ffRRRRRff'$q$
);

select pg_temp.holds (
    'the entitlement is right at once; the stored archive has not caught up yet',
    $q$select pg_temp.archived () = '000000000'$q$
);

select pg_temp.holds (
    'the hourly sweep archives the read-only seats once only the clock has moved',
    $q$select public.reconcile_district_seats () = 10 and pg_temp.archived () = '002222200'$q$
);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'an admin extends this district''s grace by a week',
    $q$select (public.admin_extend_district_grace ('d1600000-0000-4000-8000-00000000c001',
           now() + interval '7 days', 'test', 'Purchase order in progress') ->> 'grace_ends_at')::timestamptz
           = now() + interval '7 days'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'and full access is back, every score with it',
    $q$select pg_temp.seats () = 'AAAAAAAAA' and pg_temp.archived () = '000000000'$q$
);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the extension is withdrawn',
    $q$select public.admin_extend_district_grace ('d1600000-0000-4000-8000-00000000c001', null, 'test') ? 'grace_ends_at'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds ('the lapse rules apply again', $q$select pg_temp.seats () = 'ffRRRRRff'$q$);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the district pays',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '45 minutes') = 'written'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'payment restores every seat at once, scores included, and clears past_due_since',
    $q$select pg_temp.seats () = 'AAAAAAAAA' and pg_temp.archived () = '000000000'
          and (select past_due_since is null from public.subscriptions
               where stripe_subscription_id = 'sub_d16_district')$q$
);

-- A card subscription gets no grace: past due is free limits, as before.
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'a card Academy goes past due',
    $q$select pg_temp.webhook_write ('sub_d16_card', 'd1600000-0000-4000-8000-0000000000a2', 'free',
           'past_due', now() + interval '1 month', 'charge_automatically', now() - interval '45 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and its owner is on free limits at once',
    $q$select public.resolve_entitlements ('d1600000-0000-4000-8000-0000000000a2') ->> 'tier' = 'free'$q$
);

-- ===========================================================================
-- The contract end follows Stripe unless an admin pins it
-- ===========================================================================
select pg_temp.holds (
    'the district schedules its cancellation at period end',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '40 minutes', true) = 'written'$q$
);

select pg_temp.holds (
    'a scheduled cancellation sets no contract end: it has not ended, and can still move',
    $q$select contract_ends_at is null and contract_ends_source is null
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'the district resumes',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '39 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and contract_ends_at is null again: never purged',
    $q$select contract_ends_at is null and contract_ends_source is null
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'the district schedules cancellation a year out again',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '38 minutes 30 seconds', true) = 'written'$q$
);

select pg_temp.holds (
    'the district schedules cancellation a year out again: checked after the write',
    $q$select contract_ends_at is null from public.district_billing
       where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'then cancels immediately: Stripe ends it now, with the old schedule still on the object',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'free',
           'canceled', now() + interval '1 year', 'send_invoice', now() - interval '38 minutes', true,
           now() - interval '38 minutes') = 'written'$q$
);

select pg_temp.holds (
    'contract_ends_at is the day it actually ended, not the scheduled date nor the period end',
    $q$select contract_ends_at = now() - interval '38 minutes' and contract_ends_source = 'stripe'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

-- ===========================================================================
-- District to ordinary $49 Academy (the Codex scenario)
-- ===========================================================================
select pg_temp.holds (
    'the owner buys ordinary card-paid Academy',
    $q$select pg_temp.webhook_write ('sub_d16_owner_card', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 month', 'charge_automatically', now() - interval '37 minutes') = 'written'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'only 5 seats are entitled: the kept b8 and b9, then b1 and b2; the rest are read-only',
    $q$select public.studio_effective_seat_limit ('d1600000-0000-4000-8000-00000000c001') = 5
          and pg_temp.seats () = 'AARRRRRAA'$q$
);

select pg_temp.holds (
    'their scores are archived by the subscription write itself',
    $q$select pg_temp.archived () = '002222200'$q$
);

select pg_temp.holds (
    'the card subscription did not touch the district''s contract end',
    $q$select contract_ends_at = now() - interval '38 minutes' and stripe_subscription_id = 'sub_d16_district'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

-- ===========================================================================
-- Releasing a read-only seat
-- ===========================================================================
select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'the owner removes read-only b7',
    $q$select public.studio_remove_member ('d1600000-0000-4000-8000-00000000c001', 'd1600000-0000-4000-8000-0000000000b7')$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'b7 is an ordinary free teacher again, with their scores back up to the free cap',
    $q$select pg_temp.seat ('b7') = 'free'
          and not (public.resolve_entitlements ('d1600000-0000-4000-8000-0000000000b7') ->> 'seat_read_only')::boolean
          and (select count(*) from public.documents
               where owner_id = 'd1600000-0000-4000-8000-0000000000b7' and archived_at is null) = 2$q$
);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'a redelivery of the cancellation does not move the contract end',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'free',
           'canceled', now() + interval '1 year', 'send_invoice', now() - interval '36 minutes', false,
           now() - interval '38 minutes') = 'written'$q$
);

select pg_temp.holds (
    'a redelivery of the cancellation does not move the contract end: checked after the write',
    $q$select contract_ends_at = now() - interval '38 minutes' from public.district_billing
       where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'nor does a later event that omits ended_at (an older webhook): the stored end stands',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'free',
           'canceled', now() + interval '1 year', 'send_invoice', now() - interval '35 minutes 30 seconds') = 'written'$q$
);

select pg_temp.holds (
    'nor does a later event that omits ended_at (an older webhook): the stored end stands: checked after the write',
    $q$select contract_ends_at = now() - interval '38 minutes' from public.district_billing
       where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'an admin pins the contract end from the contract',
    $q$select public.admin_set_district_contract_end ('d1600000-0000-4000-8000-00000000c001',
           '2027-06-30T00:00:00Z', 'test', 'Contract #16 term') ->> 'contract_ends_source' = 'admin'$q$
);

select pg_temp.holds (
    'Stripe writes no longer move a pinned date',
    $q$select pg_temp.webhook_write ('sub_d16_district', 'd1600000-0000-4000-8000-0000000000a1', 'academy',
           'past_due', now() + interval '1 year', 'send_invoice', now() - interval '35 minutes', true) = 'written'$q$
);

select pg_temp.holds (
    'Stripe writes no longer move a pinned date: checked after the write',
    $q$select contract_ends_at = '2027-06-30T00:00:00Z' from public.district_billing
       where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'handing it back to Stripe re-derives it from the subscription: past due has not ended, so none',
    $q$select (r ->> 'contract_ends_at') is null and (r ->> 'contract_ends_source') is null
       from (select public.admin_set_district_contract_end ('d1600000-0000-4000-8000-00000000c001', null, 'test',
             'Back to Stripe', true) as r) x$q$
);

select pg_temp.holds (
    'pinning null means never purge',
    $q$select (r ->> 'contract_ends_at') is null and r ->> 'contract_ends_source' = 'admin'
       from (select public.admin_set_district_contract_end ('d1600000-0000-4000-8000-00000000c001', null, 'test',
             'Perpetual licence') as r) x$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'every change to the billing record is logged, with the actor',
    $q$select count(*) >= 6 and bool_or(actor = 'stripe') and bool_or(actor = 'test')
       from public.district_billing_log where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$
);

-- ===========================================================================
-- A cancellation long after the last billing period does not backdate the end
-- ===========================================================================
-- Codex round-2 review of #61, major 3: the old derivation took the earlier of
-- the period end and the processing time, so a district whose recorded period
-- ended three months ago would have its contract end -- and the retention
-- purge -- moved three months earlier than the day it actually ended.
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'a second district''s subscription, its recorded period long past',
    $q$select pg_temp.webhook_write ('sub_d16_late', 'd1600000-0000-4000-8000-0000000000a3', 'academy',
           'past_due', now() - interval '90 days', 'send_invoice', now() - interval '34 minutes') = 'written'$q$
);

select pg_temp.holds (
    'is cancelled now, by a webhook that does not send ended_at: the event that ended it counts',
    $q$select pg_temp.webhook_write ('sub_d16_late', 'd1600000-0000-4000-8000-0000000000a3', 'free',
           'canceled', now() - interval '90 days', 'send_invoice', now() - interval '31 minutes') = 'written'$q$
);

select pg_temp.holds (
    'is cancelled now, by a webhook that does not send ended_at: the event that ended it counts: checked after the write',
    $q$select contract_ends_at = now() - interval '31 minutes' and contract_ends_source = 'stripe'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c003'$q$
);

select pg_temp.holds (
    'and Stripe''s own ended_at, once it arrives, is what stands -- never the period end',
    $q$select pg_temp.webhook_write ('sub_d16_late', 'd1600000-0000-4000-8000-0000000000a3', 'free',
           'canceled', now() - interval '90 days', 'send_invoice', now() - interval '30 minutes', false,
           now() - interval '32 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and Stripe''s own ended_at, once it arrives, is what stands -- never the period end: checked after the write',
    $q$select contract_ends_at = now() - interval '32 minutes'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c003'$q$
);

-- ===========================================================================
-- A renewal on a new subscription: a paying district is never purgeable
-- ===========================================================================
-- Codex round-2 review of #61, major 2. The retention purge (#64) selects a
-- district once contract_ends_at is set and its first step (the export notice,
-- 16 days on) is due; "selected" below is that, a year from now, so it covers
-- every step.
create function pg_temp.purgeable (p_studio uuid) returns bigint language sql as $$
    select count(*) from public.district_billing b
    where b.studio_id = p_studio
      and b.contract_ends_at is not null
      and b.contract_ends_at + interval '16 days' <= now() + interval '1 year';
$$;

grant execute on function pg_temp.purgeable (uuid) to public;

-- Without an override: the late district (its subscription ended above) signs
-- again on a new one.
select pg_temp.holds (
    'the late district''s ended contract is purgeable',
    $q$select pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c003') = 1$q$
);

select pg_temp.holds (
    'it signs again on a new subscription',
    $q$select pg_temp.webhook_write ('sub_d16_late_renewal', 'd1600000-0000-4000-8000-0000000000a3', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '29 minutes') = 'written'$q$
);

select pg_temp.holds (
    'the record follows the live renewal and the contract end is gone: retention selects nothing',
    $q$select b.stripe_subscription_id = 'sub_d16_late_renewal' and b.contract_ends_at is null
          and b.contract_ends_source is null
          and pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c003') = 0
       from public.district_billing b where b.studio_id = 'd1600000-0000-4000-8000-00000000c003'$q$
);

-- With an override (the Codex scenario): subscription A ends, the district buys
-- B, the admin moves the override to B.
select pg_temp.holds (
    'district A is recorded',
    $q$select pg_temp.webhook_write ('sub_d16_a', 'd1600000-0000-4000-8000-0000000000a4', 'academy',
           'active', now() + interval '1 month', 'send_invoice', now() - interval '28 minutes') = 'written'$q$
);

select pg_temp.holds (
    'with a 10-seat override on A',
    $q$select (public.admin_set_studio_seat_override (
           'd1600000-0000-4000-8000-00000000c004', 10, 'sub_d16_a', 'test', 'Contract A'
       ) ->> 'effective_seat_limit')::int = 10$q$
);

select pg_temp.holds (
    'A ends',
    $q$select pg_temp.webhook_write ('sub_d16_a', 'd1600000-0000-4000-8000-0000000000a4', 'free',
           'canceled', now() + interval '1 month', 'send_invoice', now() - interval '27 minutes', false,
           now() - interval '27 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and A''s end is the contract end',
    $q$select contract_ends_at = now() - interval '27 minutes'
          and pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c004') = 1
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

select pg_temp.holds (
    'B is started but not yet paid (incomplete)',
    $q$select pg_temp.webhook_write ('sub_d16_b', 'd1600000-0000-4000-8000-0000000000a4', 'free',
           'incomplete', now() + interval '1 year', 'send_invoice', now() - interval '26 minutes') = 'written'$q$
);

select pg_temp.holds (
    'which pays for nothing yet, so A''s end stands',
    $q$select contract_ends_at = now() - interval '27 minutes' and stripe_subscription_id = 'sub_d16_a'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

select pg_temp.holds (
    'B goes active, before anyone touches the override',
    $q$select pg_temp.webhook_write ('sub_d16_b', 'd1600000-0000-4000-8000-0000000000a4', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '25 minutes') = 'written'$q$
);

select pg_temp.holds (
    'the district pays, so it is not purgeable -- even with the override still naming A',
    $q$select contract_ends_at is null and contract_ends_source is null and stripe_subscription_id = 'sub_d16_a'
          and pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c004') = 0
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

select pg_temp.holds (
    'the admin moves the override to B',
    $q$select (public.admin_set_studio_seat_override (
           'd1600000-0000-4000-8000-00000000c004', 10, 'sub_d16_b', 'test', 'Contract B'
       ) ->> 'effective_seat_limit')::int = 10$q$
);

select pg_temp.holds (
    'the record follows B, still with no contract end: retention selects nothing',
    $q$select stripe_subscription_id = 'sub_d16_b' and contract_ends_at is null
          and pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c004') = 0
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

select pg_temp.holds (
    'a late redelivery of A''s cancellation changes nothing',
    $q$select pg_temp.webhook_write ('sub_d16_a', 'd1600000-0000-4000-8000-0000000000a4', 'free',
           'canceled', now() + interval '1 month', 'send_invoice', now() - interval '24 minutes', false,
           now() - interval '27 minutes') = 'written'$q$
);

select pg_temp.holds (
    'still nothing to purge',
    $q$select pg_temp.purgeable ('d1600000-0000-4000-8000-00000000c004') = 0$q$
);

select pg_temp.holds (
    'when B ends in its turn',
    $q$select pg_temp.webhook_write ('sub_d16_b', 'd1600000-0000-4000-8000-0000000000a4', 'free',
           'canceled', now() + interval '1 year', 'send_invoice', now() - interval '23 minutes', false,
           now() - interval '23 minutes') = 'written'$q$
);

select pg_temp.holds (
    'the contract end is B''s own end, not A''s',
    $q$select contract_ends_at = now() - interval '23 minutes' and contract_ends_source = 'stripe'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

select pg_temp.holds (
    'an admin''s pin is the contract''s date: a renewal leaves it to the admin',
    $q$select public.admin_set_district_contract_end ('d1600000-0000-4000-8000-00000000c004',
           now() + interval '2 years', 'test', 'Contract C term') ->> 'contract_ends_source' = 'admin'$q$
);

select pg_temp.holds (
    'contract C is signed',
    $q$select pg_temp.webhook_write ('sub_d16_c', 'd1600000-0000-4000-8000-0000000000a4', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '22 minutes') = 'written'$q$
);

select pg_temp.holds (
    'and the pinned date stands',
    $q$select contract_ends_at = now() + interval '2 years' and contract_ends_source = 'admin'
       from public.district_billing where studio_id = 'd1600000-0000-4000-8000-00000000c004'$q$
);

-- ===========================================================================
-- Nobody but the admin reaches any of it
-- ===========================================================================
select pg_temp.act_as_user ('d1600000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'the owner cannot read the billing record',
    $q$select count(*) from public.district_billing$q$,
    '42501'
);

select pg_temp.refused (
    'nor its log',
    $q$select count(*) from public.district_billing_log$q$,
    '42501'
);

select pg_temp.refused (
    'nor set the contract end',
    $q$select public.admin_set_district_contract_end ('d1600000-0000-4000-8000-00000000c001', null, 'me')$q$,
    '42501'
);

select pg_temp.refused (
    'nor extend grace',
    $q$select public.admin_extend_district_grace ('d1600000-0000-4000-8000-00000000c001', now() + interval '1 year', 'me')$q$,
    '42501'
);

select pg_temp.refused (
    'nor run the reconcile',
    $q$select public.reconcile_studio_seats ('d1600000-0000-4000-8000-00000000c001')$q$,
    '42501'
);

select pg_temp.refused (
    'nor write kept_active directly',
    $q$update public.studio_members set kept_active = true
       where studio_id = 'd1600000-0000-4000-8000-00000000c001'$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'the hourly sweep is scheduled',
    $q$select count(*) = 1 from cron.job where jobname = 'district-seat-reconcile'$q$
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
