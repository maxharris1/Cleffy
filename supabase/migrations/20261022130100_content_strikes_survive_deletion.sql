-- Copyright strikes survive the account they were given to, for as long as
-- they can count.
--
-- Launch re-audit, SF-15: content_strikes.user_id was ON DELETE CASCADE
-- (20261020150000), so deleting an account (delete-account, the 12-month
-- archived-student purge, the stale-guest purge, a district hard delete: every
-- path ends in `delete from auth.users`) deleted its strikes, and signing up
-- again with the same address started the repeat-infringer count (Copyright
-- and Content Policy, "Repeat infringers") from zero.
--
--  (a) The foreign key nulls user_id instead: the strike row stays, as the
--      takedown it came from already does (content_takedowns.uploader_id is
--      ON DELETE SET NULL, unchanged here).
--  (b) When the account is deleted, and not before, its strikes that still
--      count (not withdrawn, inside the 12-month window) are keyed with the
--      account's address AT THAT MOMENT, read from the auth.users row being
--      deleted (a BEFORE DELETE trigger, under the delete's own row lock, so
--      an email change cannot slip in between). A live strike carries no key:
--      it counts by user_id. Keying at deletion is what keeps an address the
--      account gave up earlier (an email change) from inheriting its strikes
--      (Codex round 1 on #66, major 1).
--  (c) The key is versioned and keyed: subject_key_version 1 is
--      hex(hmac-sha256(pepper, lower(btrim(email)))), the pepper read
--      server-side from the Vault secret `content_strike_pepper`. Without the
--      pepper a database or backup reader cannot test candidate addresses
--      against the keys (Codex round 1 on #66, major 2). Missing, it fails
--      closed with a clear error and never a plain digest: deleting an account
--      that has strikes to key is refused, and so is counting strikes while
--      keyed ones exist. The pepper is never logged or returned. A later
--      version would name its own secret and be added beside version 1, which
--      can be retired once its keys have been purged (12 months at most, (e)).
--  (d) active_content_strikes() also counts strikes whose account is gone
--      (user_id null) and whose key is the user's current address under the
--      key's version, inside the same window: an address re-registered
--      inherits them.
--  (e) Retention: retention_purge_content_strikes() deletes a deleted
--      account's strikes 12 months after the newest strike under the same key
--      (and an unkeyed one 12 months after it was given), daily, through the
--      retention job pattern of 20261021120300 (scheduled and active, as those
--      jobs are). The takedown records are not touched.
--
-- The 12-month window and the voiding on a successful counter-notice are
-- unchanged (STRIKE_WINDOW_MONTHS, src/features/moderation/moderationRules.ts).
-- No table grant is added here: launchfix P1 grants content_strikes explicitly.
--
-- Rerunnable: the columns are added once, the foreign key is replaced only
-- while it still cascades, the triggers are dropped just before they are
-- created, the functions are replaced, and the job is unscheduled before it is
-- scheduled.
--
-- DEPLOY: set the Vault secret `content_strike_pepper` on production before
-- go-live (a long random value, kept nowhere else; Max only):
--     select vault.create_secret ('<random>', 'content_strike_pepper', 'Keys copyright strikes after account deletion');
-- Until it is set, deleting an account with active strikes fails. Never change
-- or delete it while version-1 keys exist: they would stop matching. Local
-- stacks and CI get a non-secret dev value from supabase/seed.sql.

alter table public.content_strikes
alter column user_id drop not null;

alter table public.content_strikes
add column if not exists subject_key text;

alter table public.content_strikes
add column if not exists subject_key_version smallint;

do $content_strikes_user_fk$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.content_strikes'::regclass
          and conname = 'content_strikes_user_id_fkey'
          and confdeltype = 'n'
    ) then
        alter table public.content_strikes drop constraint if exists content_strikes_user_id_fkey;
        alter table public.content_strikes
        add constraint content_strikes_user_id_fkey
        foreign key (user_id) references auth.users (id) on delete set null;
    end if;
end;
$content_strikes_user_fk$;

create index if not exists content_strikes_subject_key_idx on public.content_strikes (subject_key, created_at desc)
where user_id is null and subject_key is not null;

-- This PR's first revision keyed with plain sha256 through this helper.
drop function if exists public.content_strike_subject_key (text);

-- The pepper for a key version, from Vault. Raises rather than answer without
-- one; the message names the secret, never its value. Internal.
create or replace function public.content_strike_pepper (p_version smallint) returns text language plpgsql stable
security definer
set search_path = public, vault as $$
declare
    v_pepper text;
begin
    if p_version is distinct from 1 then
        raise exception 'unknown content strike key version %', p_version using errcode = '22023';
    end if;
    select s.decrypted_secret into v_pepper from vault.decrypted_secrets s where s.name = 'content_strike_pepper' limit 1;
    if coalesce(v_pepper, '') = '' then
        raise exception 'the Vault secret content_strike_pepper is not set: copyright strikes cannot be keyed or matched'
            using errcode = '55000',
                  hint = 'Set it with vault.create_secret before deleting accounts or counting strikes (DEPLOY note in 20261022130100).';
    end if;
    return v_pepper;
end;
$$;

-- The key of a sign-in address under a version; null for no address (a
-- guest), without reading the pepper. Internal.
create or replace function public.content_strike_subject_key (p_email text, p_version smallint) returns text
language sql stable
security definer
set search_path = public, extensions as $$
    select case when nullif(btrim(coalesce(p_email, '')), '') is null then null
                else encode(extensions.hmac(convert_to(lower(btrim(p_email)), 'UTF8'),
                                            convert_to(public.content_strike_pepper (p_version), 'UTF8'), 'sha256'),
                            'hex') end;
$$;

-- A strike is inserted unkeyed, whatever the insert said: keys are made only
-- when the account is deleted.
create or replace function public.content_strikes_set_subject_key () returns trigger language plpgsql
security definer
set search_path = public as $$
begin
    new.subject_key := null;
    new.subject_key_version := null;
    return new;
end;
$$;

drop trigger if exists content_strikes_set_subject_key on public.content_strikes;

create trigger content_strikes_set_subject_key before insert on public.content_strikes
for each row execute function public.content_strikes_set_subject_key ();

-- The account is being deleted: key the strikes that still count with the
-- address it has now, before the foreign key nulls their user_id. Strikes
-- already withdrawn or outside the window stay unkeyed (and are purged).
create or replace function public.content_strikes_key_on_account_delete () returns trigger language plpgsql
security definer
set search_path = public as $$
declare
    v_key text;
begin
    if exists (
        select 1 from public.content_strikes s
        where s.user_id = old.id and s.voided_at is null and s.created_at > now() - interval '12 months'
    ) then
        v_key := public.content_strike_subject_key (old.email, 1::smallint);
        if v_key is not null then
            update public.content_strikes s
            set subject_key = v_key, subject_key_version = 1
            where s.user_id = old.id and s.voided_at is null and s.created_at > now() - interval '12 months';
        end if;
    end if;
    return old;
end;
$$;

drop trigger if exists content_strikes_key_on_account_delete on auth.users;

create trigger content_strikes_key_on_account_delete before delete on auth.users
for each row execute function public.content_strikes_key_on_account_delete ();

-- Strikes that count: not withdrawn, within the window the policy states
-- (STRIKE_WINDOW_MONTHS in src/features/moderation/moderationRules.ts), and
-- either the user's own or left by a deleted account under the user's
-- address. The pepper is read only when such keyed strikes exist.
create or replace function public.active_content_strikes (p_user uuid) returns integer language plpgsql stable
security definer
set search_path = public as $$
declare
    v_count int;
    v_email text;
    v_version smallint;
    v_key text;
    v_inherited int;
begin
    select count(*)::int into v_count
    from public.content_strikes s
    where s.user_id = p_user and s.voided_at is null and s.created_at > now() - interval '12 months';

    select u.email into v_email from auth.users u where u.id = p_user;
    if nullif(btrim(coalesce(v_email, '')), '') is null then
        return v_count;
    end if;

    for v_version in
        select distinct s.subject_key_version
        from public.content_strikes s
        where s.user_id is null and s.subject_key is not null
          and s.voided_at is null and s.created_at > now() - interval '12 months'
    loop
        v_key := public.content_strike_subject_key (v_email, v_version);
        select count(*)::int into v_inherited
        from public.content_strikes s
        where s.user_id is null and s.subject_key = v_key and s.subject_key_version = v_version
          and s.voided_at is null and s.created_at > now() - interval '12 months';
        v_count := v_count + v_inherited;
    end loop;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention: a deleted account's strikes, 12 months after the newest under
-- the same key (when the last of them stops counting); an unkeyed one, 12
-- months after it was given. Bounded per run, like the jobs of 20261021120300.
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_content_strikes (
    p_older_than interval default interval '12 months',
    p_batch int default 1000
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    purged int;
begin
    delete from public.content_strikes d
    where d.id in (
        select s.id
        from public.content_strikes s
        where s.user_id is null
          and s.created_at < now() - p_older_than
          and (s.subject_key is null
               or not exists (
                   select 1 from public.content_strikes n
                   where n.user_id is null and n.subject_key = s.subject_key
                     and n.subject_key_version is not distinct from s.subject_key_version
                     and n.created_at >= now() - p_older_than
               ))
        order by s.created_at
        limit greatest(p_batch, 0)
    );
    get diagnostics purged = row_count;
    return purged;
end;
$$;

revoke all on function public.content_strike_pepper (smallint) from public, anon, authenticated, service_role;

revoke all on function public.content_strike_subject_key (text, smallint) from public, anon, authenticated, service_role;

revoke all on function public.content_strikes_set_subject_key () from public, anon, authenticated;

revoke all on function public.content_strikes_key_on_account_delete () from public, anon, authenticated;

revoke all on function public.active_content_strikes (uuid) from public, anon, authenticated;

grant execute on function public.active_content_strikes (uuid) to service_role;

revoke all on function public.retention_purge_content_strikes (interval, int) from public, anon, authenticated;

grant execute on function public.retention_purge_content_strikes (interval, int) to service_role;

-- Off the hour and clear of 20261021120300's 03:17-04:23 jobs; unscheduled
-- first so a re-applied migration replaces rather than duplicates.
do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'retention-content-strikes';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('retention-content-strikes', '7 4 * * *', $$select public.retention_purge_content_strikes ()$$);
