-- Share v2, part 4 of 4: editor-link guests (#104, D8, and the age gate for
-- "Anyone with the link: Editor").
--
-- An editor link's visitor may type a name and goes straight to editing, with
-- no age screen (Max, 2026-11-13). The app signs them in as an anonymous guest
-- whose age gate is exactly {"source":"link_guest","v":2}. That gate is
-- accepted only for an anonymous user, in the hook and in the auth.users
-- insert trigger alike; it never creates a registered account. Turning such a
-- guest into an account (guest-email-confirm) asks the age screen first: the
-- new gate must be written before is_anonymous is cleared, and the database
-- refuses the flip while the gate is still link_guest.
--
-- D8: idle link guests are deleted after a window each score owner sets (1 to
-- 90 days, 30 by default). A guest on several owners' scores is kept until the
-- longest of their windows passes, never beyond 90 days; every other guest
-- stays at 90 days.
--
-- Safe to run twice.

-- ---------------------------------------------------------------------------
-- The age gate
-- ---------------------------------------------------------------------------
-- age_gate_problem (20261111180000), with the one gate that skips the age
-- screen: an anonymous link guest's.
create or replace function public.age_gate_problem_for (p_user_metadata jsonb, p_is_anonymous boolean) returns text language plpgsql immutable
set search_path = '' as $$
begin
    if p_user_metadata -> 'age_gate' = '{"source": "link_guest", "v": 2}'::jsonb then
        return case when coalesce(p_is_anonymous, false) then null else 'age_check_missing' end;
    end if;
    return public.age_gate_problem (p_user_metadata);
end;
$$;

revoke all on function public.age_gate_problem_for (jsonb, boolean) from public, anon, authenticated;
grant execute on function public.age_gate_problem_for (jsonb, boolean) to service_role, supabase_auth_admin;

-- 20261021120000's hook: the event carries is_anonymous (spike e).
create or replace function public.hook_before_user_created (event jsonb) returns jsonb language plpgsql stable
set search_path = '' as $$
declare
    problem text := public.age_gate_problem_for (
        coalesce(event -> 'user' -> 'user_metadata', '{}'::jsonb),
        coalesce(event -> 'user' -> 'is_anonymous', 'false'::jsonb) = 'true'::jsonb
    );
begin
    if problem is null then
        return '{}'::jsonb;
    end if;
    if problem = 'age_check_missing' then
        return jsonb_build_object(
            'error',
            jsonb_build_object(
                'http_code', 400,
                'message', 'Sign-up needs the age check first. Reload the page and try again.'
            )
        );
    end if;
    return jsonb_build_object(
        'error',
        jsonb_build_object('http_code', 403, 'message', 'Sorry, you can’t create a Cleffy account.')
    );
end;
$$;

-- 20261111180000's insert trigger, reading the row's own is_anonymous.
create or replace function public.enforce_age_gate_on_user () returns trigger language plpgsql
set search_path = '' as $$
declare
    problem text;
begin
    if current_user is distinct from 'supabase_auth_admin' then
        return new;
    end if;
    problem := public.age_gate_problem_for (coalesce(new.raw_user_meta_data, '{}'::jsonb), new.is_anonymous);
    if problem is null then
        return new;
    end if;
    if problem = 'age_check_missing' then
        raise exception 'Sign-up needs the age check first. Reload the page and try again.'
            using errcode = '22023';
    end if;
    raise exception 'Sorry, you can’t create a Cleffy account.'
        using errcode = '42501';
end;
$$;

-- 20261010120200's guard, plus: a guest whose gate is still link_guest stays
-- a guest. guest-email-confirm writes the age screen's gate first.
create or replace function public.guard_guest_email () returns trigger language plpgsql security definer
set search_path = '' as $$
declare
    v_upgrades text := coalesce(current_setting('cleffy.guest_upgrades', true), '');
    v_leaving boolean := old.is_anonymous and not new.is_anonymous;
    v_email_changes boolean := nullif(new.email, '') is not null
        and lower(coalesce(old.email, '')) is distinct from lower(new.email);
    v_proven text;
begin
    if not (v_leaving or v_email_changes) or new.deleted_at is not null then
        return new;
    end if;
    if v_leaving and new.raw_user_meta_data -> 'age_gate' ->> 'source' = 'link_guest' then
        raise exception 'a link guest takes the age check before getting an account'
            using errcode = '42501';
    end if;
    if not (old.is_anonymous or new.is_anonymous or strpos(v_upgrades, new.id::text) > 0) then
        return new;
    end if;

    select g.verified_email into v_proven
    from public.guest_email_verifications g
    where g.user_id = new.id
        and g.verified_at > clock_timestamp() - interval '10 minutes';
    if not found then
        raise exception 'a guest account gets an email address only through guest-email-confirm'
            using errcode = '42501';
    end if;
    if v_email_changes and lower(new.email) <> v_proven then
        raise exception 'that is not the address the guest proved'
            using errcode = '42501';
    end if;

    if v_leaving then
        perform set_config('cleffy.guest_upgrades', v_upgrades || new.id::text || ',', true);
    end if;
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- D8: the owner's idle window for link guests
-- ---------------------------------------------------------------------------
create table if not exists public.share_owner_settings (
    owner_id uuid primary key references auth.users (id) on delete cascade,
    link_guest_idle_days integer not null default 30 check (link_guest_idle_days between 1 and 90),
    updated_at timestamptz not null default now()
);

alter table public.share_owner_settings enable row level security;
revoke all on table public.share_owner_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.share_owner_settings to service_role;

create or replace function public.share_settings_assert_caller () returns uuid language plpgsql stable security definer
set search_path = '' as $$
declare
    v_uid uuid := auth.uid ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    if exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous)
       or exists (select 1 from public.managed_students ms where ms.student_user_id = v_uid) then
        raise exception 'only a score owner''s account has sharing settings' using errcode = '42501';
    end if;
    return v_uid;
end;
$$;

revoke all on function public.share_settings_assert_caller () from public, anon, authenticated;

create or replace function public.set_link_guest_retention (p_days integer) returns integer language plpgsql security definer
set search_path = '' as $$
declare
    v_uid uuid := public.share_settings_assert_caller ();
begin
    if p_days is null or p_days not between 1 and 90 then
        raise exception 'idle link guests are deleted after 1 to 90 days'
            using errcode = '22023', detail = json_build_object('code', 'invalid_retention_days')::text;
    end if;
    insert into public.share_owner_settings as s (owner_id, link_guest_idle_days)
    values (v_uid, p_days)
    on conflict (owner_id) do update set link_guest_idle_days = excluded.link_guest_idle_days, updated_at = now();
    return p_days;
end;
$$;

revoke all on function public.set_link_guest_retention (integer) from public, anon;
grant execute on function public.set_link_guest_retention (integer) to authenticated;

create or replace function public.my_share_settings () returns jsonb language sql stable security definer
set search_path = '' as $$
    select jsonb_build_object(
        'link_guest_idle_days',
        coalesce(
            (select s.link_guest_idle_days from public.share_owner_settings s where s.owner_id = public.share_settings_assert_caller ()),
            30
        )
    );
$$;

revoke all on function public.my_share_settings () from public, anon;
grant execute on function public.my_share_settings () to authenticated;

-- How long p_user may sit idle before the purge: for a link guest, the longest
-- window among the owners of the scores they are on (30 days for an owner who
-- never chose), at most 90 days; for anyone else, p_default.
create or replace function public.retention_guest_idle_window (p_user uuid, p_default interval) returns interval language sql stable security definer
set search_path = '' as $$
    select case
        when u.raw_user_meta_data -> 'age_gate' ->> 'source' is distinct from 'link_guest' then p_default
        else least(
            interval '90 days',
            make_interval(days => coalesce((
                select max(coalesce(s.link_guest_idle_days, 30))
                from public.document_members dm
                join public.documents d on d.id = dm.document_id
                left join public.share_owner_settings s on s.owner_id = d.owner_id
                where dm.user_id = u.id
            ), 30))
        )
    end
    from auth.users u
    where u.id = p_user;
$$;

revoke all on function public.retention_guest_idle_window (uuid, interval) from public, anon, authenticated;

-- 20261021120500's purge, with each guest's own window (the cron passes 90
-- days, which stays every other guest's). The scan asks the full question, so
-- a batch is never filled with guests still inside their window.
create or replace function public.retention_purge_stale_guests (p_idle interval default '90 days', p_batch integer default 1000) returns integer language plpgsql security definer
set search_path = public as $$
declare
    candidate record;
    v_floor timestamptz := now() - least(p_idle, interval '1 day');
    purged int := 0;
begin
    for candidate in
        select u.id
        from auth.users u
        where u.is_anonymous
          and public.retention_guest_last_active (u.id) < v_floor
          and public.retention_guest_last_active (u.id) < now() - public.retention_guest_idle_window (u.id, p_idle)
        order by u.created_at
        limit greatest(p_batch, 0)
    loop
        perform 1
        from auth.users u
        where u.id = candidate.id
          and u.is_anonymous
          and public.retention_guest_last_active (u.id) < now() - public.retention_guest_idle_window (u.id, p_idle)
        for update skip locked;

        if not found then
            continue;
        end if;

        delete from auth.users where id = candidate.id;
        purged := purged + 1;
    end loop;
    return purged;
end;
$$;
