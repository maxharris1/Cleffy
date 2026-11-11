-- refund_edge_rate_limit (migration 20261011120101_refund_edge_rate_limit):
-- guest-email-start reserves a send with check_edge_rate_limit and hands it
-- back when no mail went out.
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

create function pg_temp.refused (p_name text, p_sql text, p_state text) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state, v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

create function pg_temp.bucket_count (p_key text) returns int language sql as $$
    select count from public.edge_rate_buckets where key = p_key
$$;

-- ===========================================================================
-- The service role: reserve, refund, reserve again
-- ===========================================================================
select pg_temp.act_as ('service_role');

-- A mailbox allowed one mail an hour: the reservation takes it...
select pg_temp.holds (
    'a first send reserves the only slot',
    $q$select (public.check_edge_rate_limit ('refund-test:mailbox', 1, 3600000) ->> 'ok')::boolean
          and pg_temp.bucket_count ('refund-test:mailbox') = 1$q$
);

select pg_temp.holds (
    'while it is held, a second send is refused',
    $q$select not (public.check_edge_rate_limit ('refund-test:mailbox', 1, 3600000) ->> 'ok')::boolean$q$
);

-- ...the mail did not go out, so it is handed back...
select public.refund_edge_rate_limit ('refund-test:mailbox');

select pg_temp.holds (
    'a refund hands back one use',
    $q$select pg_temp.bucket_count ('refund-test:mailbox') = 0$q$
);

-- ...and the next try may send.
select pg_temp.holds (
    'after the refund the next send is allowed',
    $q$select (public.check_edge_rate_limit ('refund-test:mailbox', 1, 3600000) ->> 'ok')::boolean$q$
);

select public.refund_edge_rate_limit ('refund-test:mailbox');

select public.refund_edge_rate_limit ('refund-test:mailbox');

select pg_temp.holds (
    'a refund never takes a bucket below zero',
    $q$select pg_temp.bucket_count ('refund-test:mailbox') = 0$q$
);

select public.refund_edge_rate_limit ('refund-test:never-used');

select pg_temp.holds (
    'refunding a bucket that does not exist creates nothing',
    $q$select not exists (select 1 from public.edge_rate_buckets where key = 'refund-test:never-used')$q$
);

-- A refund that arrives after its window rolled over is not taken out of the
-- next window (the expired bucket would be reset to 1 on the next check).
select pg_temp.act_as_server ();

insert into public.edge_rate_buckets (key, count, reset_at)
values ('refund-test:expired', 3, clock_timestamp() - interval '1 second');

select pg_temp.act_as ('service_role');

select public.refund_edge_rate_limit ('refund-test:expired');

select pg_temp.holds (
    'an expired window is left alone',
    $q$select pg_temp.bucket_count ('refund-test:expired') = 3$q$
);

-- ===========================================================================
-- Anyone else: a way to undo every limit, so refused
-- ===========================================================================
select pg_temp.act_as ('authenticated');

select pg_temp.refused (
    'a signed-in user cannot refund a bucket',
    $q$select public.refund_edge_rate_limit ('refund-test:mailbox')$q$,
    '42501'
);

select pg_temp.act_as ('anon');

select pg_temp.refused (
    'anon cannot refund a bucket',
    $q$select public.refund_edge_rate_limit ('refund-test:mailbox')$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'definer function pins search_path',
    $q$select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
       from pg_proc p
       where p.oid = 'public.refund_edge_rate_limit'::regproc$q$
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
