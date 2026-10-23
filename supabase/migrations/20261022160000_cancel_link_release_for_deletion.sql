-- A cancel link spent just as the account's deletion began is put back
-- unspent (launch-fix item 16; Codex r1 finding 3 on #73, decision 72(1)).
--
-- billing-cancel asks account_deletion_pending() before it spends a link, and
-- while the deletion is pending leaves both Stripe and the link alone: the
-- deletion cancels the subscription itself, and an abandoned deletion leaves a
-- link that still cancels. But that question is a moment, not a lock -- the
-- predicate's shared lock ends with its own call. A deletion beginning just
-- after it, and cancelling the subscription before the link reaches Stripe,
-- left the link SPENT (consume_cancel_link_token, 20261020160700) and Stripe
-- answering that there was nothing to cancel: if that deletion was then
-- abandoned, the buyer's link was used up for nothing. Now:
--
--   * release_cancel_link_token_for_deletion (below) is asked once the link is
--     spent and Stripe has been read, and again if Stripe refuses the update
--     (cancelFlow.ts deletionBeganSince). Under the account's deletion lock,
--     taken SHARED by account_deletion_pending() and held to the end of this
--     call, it answers whether the deletion is pending -- and if it is, puts
--     the link back unspent in the same transaction, so the answer and the
--     link agree. Then billing-cancel answers as for a deletion pending from
--     the start: Stripe left alone, the refund request sent. Otherwise it
--     changes nothing and the cancel goes on. `not_found`: no such link;
--   * the token table's guard (billing_cancel_tokens_lifetime, as
--     20261020160700 defines it) refuses ANY update that un-spends a link --
--     the service role's direct UPDATE included -- except the one this
--     function makes, which names the link's hash in a transaction-local
--     setting first. Every other refusal is unchanged: no un-spending by
--     anyone else, no new expiry, nothing that changes what the link cancels;
--   * the deletion's lock is taken before the link's history locks
--     (billing_cancel_link_lock, 20261020160600). Nothing that takes the
--     deletion's lock exclusively (begin, settle, mark destructive, the stale
--     sweep) takes a link's lock, so the order cannot meet its reverse.
--
-- A released link keeps its expiry: it works for what is left of its hour,
-- and after that the buyer asks for a new one, as for any link.
--
-- tests/sql/cancel_link_release_for_deletion.sql proves it, tests/billing/
-- cancelLinkStore.test.ts runs the store against it, and tests/billing/
-- cancelFlow.test.ts holds the flow.
--
-- Safe to re-run: both functions are CREATE OR REPLACE (the trigger that
-- calls the guard is 20261020160300's, unchanged), and the grants and revokes
-- are idempotent.

-- ---------------------------------------------------------------------------
-- The token table's guard: spent stays spent, but for one release
-- ---------------------------------------------------------------------------
-- As 20261020160700 defines it, with one exception to "a spent cancel link
-- stays spent": used_at set back to null on the row whose hash
-- release_cancel_link_token_for_deletion named in cleffy.cancel_link_release.
-- A session that never set it reads NULL, coalesced to '': no hash matches.
create or replace function public.billing_cancel_tokens_lifetime ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
    v_kind text;
    v_expires timestamptz;
begin
    if tg_op = 'INSERT' then
        select o.status, o.kind, o.link_expires_at into v_status, v_kind, v_expires
        from public.billing_mail_outbox o
        where o.id = new.outbox_id;
        if new.outbox_id is null or v_kind is distinct from 'cancel_link' or v_status is distinct from 'pending'
           or v_expires <= clock_timestamp() then
            raise exception 'a cancel link is only saved for its own request, while it waits to send and before it expires'
                using errcode = '55000';
        end if;
        new.expires_at := v_expires;
        return new;
    end if;

    if tg_op = 'UPDATE' then
        if new.token_hash <> old.token_hash
           or new.user_id <> old.user_id
           or new.mode <> old.mode
           or new.outbox_id is distinct from old.outbox_id
           or new.expires_at > old.expires_at then
            raise exception 'a saved cancel link keeps its expiry and what it cancels'
                using errcode = '55000';
        end if;
        if old.used_at is not null and new.used_at is distinct from old.used_at
           and not (new.used_at is null
                    and coalesce(pg_catalog.current_setting('cleffy.cancel_link_release', true), '') = old.token_hash) then
            raise exception 'a spent cancel link stays spent'
                using errcode = '55000';
        end if;
        if old.used_at is null and new.used_at is not null
           and new.expires_at <= clock_timestamp() then
            raise exception 'an expired cancel link cannot be spent'
                using errcode = '55000';
        end if;
        return new;
    end if;

    -- DELETE
    if exists (select 1 from auth.users u where u.id = old.user_id)
       and (old.expires_at > now()
            or exists (select 1 from public.billing_mail_outbox o where o.id = old.outbox_id and o.status = 'pending')) then
        raise exception 'a cancel link is kept until it has expired and its request can no longer be retried'
            using errcode = '55000';
    end if;
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_lifetime () from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- release_cancel_link_token_for_deletion: unspent again while being deleted
-- ---------------------------------------------------------------------------
-- Answers {"answer": ...}:
--   released  -- the link's account is being deleted (account_deletion_pending()
--                under its lock): the link is unspent now, whether this call
--                un-spent it or it already was;
--   clear     -- the account is not being deleted: nothing written;
--   not_found -- no such link (never saved, or deleted with its account).
-- The setting that lets the guard through is transaction-local and cleared
-- before returning, and names this one link.
create or replace function public.release_cancel_link_token_for_deletion (p_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_outbox uuid;
    v_user uuid;
begin
    select t.outbox_id, t.user_id into v_outbox, v_user
    from public.billing_cancel_tokens t
    where t.token_hash = p_hash;
    if not found then
        return jsonb_build_object('answer', 'not_found');
    end if;

    -- The deletion's lock first, shared, to the end of this transaction: a
    -- deletion beginning now waits for this answer, and one being settled has
    -- been.
    if not public.account_deletion_pending (v_user) then
        return jsonb_build_object('answer', 'clear');
    end if;

    perform public.billing_cancel_link_lock (v_outbox, p_hash);
    perform pg_catalog.set_config('cleffy.cancel_link_release', p_hash, true);
    update public.billing_cancel_tokens t
    set used_at = null
    where t.token_hash = p_hash
      and t.used_at is not null;
    perform pg_catalog.set_config('cleffy.cancel_link_release', '', true);
    if not exists (select 1 from public.billing_cancel_tokens t where t.token_hash = p_hash) then
        return jsonb_build_object('answer', 'not_found');
    end if;
    return jsonb_build_object('answer', 'released');
end;
$$;

revoke all on function public.release_cancel_link_token_for_deletion (text) from public, anon, authenticated;
grant execute on function public.release_cancel_link_token_for_deletion (text) to service_role;
