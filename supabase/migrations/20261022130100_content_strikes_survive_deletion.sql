-- Copyright strikes survive the account they were given to.
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
--  (b) Each strike carries subject_key: sha256(lower(email)) of the uploader's
--      sign-in address, hex, no HMAC. It is set from auth.users when the strike
--      is inserted (a trigger, so apply_content_takedown and any other insert
--      path get it), and backfilled below for existing strikes. A guest (no
--      address) has none.
--  (c) active_content_strikes() also counts strikes whose account is gone
--      (user_id null) and whose subject_key is the digest of the user's
--      current address: an address re-registered inherits them. A strike whose
--      account still exists counts for that account only, so an address freed
--      by an email change does not hand its owner's strikes to whoever takes
--      it next.
--
-- The 12-month window and the voiding on a successful counter-notice are
-- unchanged (STRIKE_WINDOW_MONTHS, src/features/moderation/moderationRules.ts).
-- No table grant is added here: launchfix P1 grants content_strikes explicitly.
--
-- Rerunnable: the column is added once, the foreign key is replaced only while
-- it still cascades, the backfill fills only missing keys, the trigger is
-- dropped just before it is created, and the functions are replaced.

alter table public.content_strikes
alter column user_id drop not null;

alter table public.content_strikes
add column if not exists subject_key text;

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

-- The digest of a sign-in address; null for none. Internal.
create or replace function public.content_strike_subject_key (p_email text) returns text language sql immutable
set search_path = public as $$
    select case when nullif(btrim(coalesce(p_email, '')), '') is null then null
                else encode(sha256(convert_to(lower(p_email), 'UTF8')), 'hex') end;
$$;

-- Set on insert from the account's address, whatever the insert said. Not on
-- update: the foreign key's SET NULL is an update, and the key must outlive it.
create or replace function public.content_strikes_set_subject_key () returns trigger language plpgsql
security definer
set search_path = public as $$
begin
    if new.user_id is not null then
        new.subject_key := (select public.content_strike_subject_key (u.email) from auth.users u where u.id = new.user_id);
    end if;
    return new;
end;
$$;

drop trigger if exists content_strikes_set_subject_key on public.content_strikes;

create trigger content_strikes_set_subject_key before insert on public.content_strikes
for each row execute function public.content_strikes_set_subject_key ();

-- Strikes given before this migration, while their account still exists.
-- (Strikes whose account was already deleted went with it, under the cascade.)
update public.content_strikes s
set subject_key = public.content_strike_subject_key (u.email)
from auth.users u
where u.id = s.user_id
  and s.subject_key is null
  and public.content_strike_subject_key (u.email) is not null;

-- Strikes that count: not withdrawn, within the window the policy states
-- (STRIKE_WINDOW_MONTHS in src/features/moderation/moderationRules.ts), and
-- either the user's own or left by a deleted account with the user's address.
create or replace function public.active_content_strikes (p_user uuid) returns integer language sql stable security definer
set search_path = public as $$
    with subject as (
        select public.content_strike_subject_key (u.email) as key from auth.users u where u.id = p_user
    )
    select count(*)::int
    from public.content_strikes s
    where (s.user_id = p_user
           or (s.user_id is null and s.subject_key is not null
               and s.subject_key = (select key from subject)))
      and s.voided_at is null
      and s.created_at > now() - interval '12 months';
$$;

revoke all on function public.content_strike_subject_key (text) from public, anon, authenticated;

revoke all on function public.content_strikes_set_subject_key () from public, anon, authenticated;

revoke all on function public.active_content_strikes (uuid) from public, anon, authenticated;

grant execute on function public.active_content_strikes (uuid) to service_role;
