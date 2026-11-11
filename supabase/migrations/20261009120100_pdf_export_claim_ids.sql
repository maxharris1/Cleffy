-- A PDF export claim the client could not use must not cost a second one.
--
-- 20261007120300 made claim_pdf_export() the one place the pdf_exports
-- allowance is decided. Two gaps were left between that decision and the file
-- reaching the teacher, and on the free plan (one export a month) either one
-- turned "Please try again" into a refusal:
--  * the shipped client claimed BEFORE flattening, so an export that then failed
--    to build had already spent the month's export. The client now builds the
--    PDF first and claims only once the file exists; that half needs nothing
--    here.
--  * an answer can be lost after the server committed it (the connection drops
--    on the way back), or the file can be built and claimed and then not
--    delivered (the share sheet dismissed). Asking again counted again.
--
-- So a claim can now carry an id the CLIENT mints for one export attempt. A
-- repeat of that id, by the same caller, for the same score, within an hour, is
-- answered ok again WITHOUT counting: it is the same export being retried, not
-- a new one. Nothing is ever given back -- there is no release to call, so no
-- way to spend and un-spend -- and an id buys at most the one unit it was first
-- answered ok for:
--  * only an ok answer is recorded; a refused id is forgotten, so it never
--    replays as ok;
--  * a replay must come from the claimer (auth.uid(), never an argument), be
--    billed to the same account and, for a share-link guest, name the same
--    score;
--  * after the hour the id is spent for good and is refused (22023) rather than
--    counted afresh, so a client never silently pays twice for one id.
-- The export is flattened on-device, so none of this can stop a modified client
-- from exporting without asking at all (see 20261007120300); what it keeps
-- honest is the shipped client, which mints a fresh id per export and keeps it
-- only until that export has been delivered.
--
-- A call with no id (bundles already in the field, consume_pdf_export) behaves
-- exactly as before: every ok answer counts.
--
-- Unlimited plans, students and an unlimited owner's guests record nothing --
-- nothing was counted, so there is nothing a retry could double.

create table public.pdf_export_claims (
    -- Minted by the client per export attempt, so a retry can name it again.
    id uuid primary key,
    claimed_by uuid not null references auth.users (id) on delete cascade,
    -- Whose allowance the unit came from: the caller, or a guest's score owner.
    billed_to uuid not null references auth.users (id) on delete cascade,
    -- The score a share-link guest named; null for an account's own export.
    document_id uuid,
    created_at timestamptz not null default now()
);

-- Rows exist only for a counted unit, so a billed account holds at most its
-- monthly allowance of them per month: nothing here needs sweeping.
create index pdf_export_claims_billed_to on public.pdf_export_claims (billed_to);
create index pdf_export_claims_claimed_by on public.pdf_export_claims (claimed_by);

-- Server bookkeeping only: claim_pdf_export() is the sole reader and writer.
alter table public.pdf_export_claims enable row level security;

revoke all on table public.pdf_export_claims from public;
revoke all on table public.pdf_export_claims from anon;
revoke all on table public.pdf_export_claims from authenticated;

-- A new trailing parameter with a default would leave the old one-argument
-- function beside it, and claim_pdf_export(p_document => x) would then match
-- both. One function, so every caller -- old bundles naming only p_document,
-- or nothing -- resolves to it.
drop function if exists public.claim_pdf_export (uuid);

-- 20261007120300's body, with the claim id woven in around consume_quota.
create or replace function public.claim_pdf_export (p_document uuid default null, p_claim uuid default null) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_guest boolean;
    v_owner uuid;
    v_billed uuid;
    v_scope uuid;
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_prior public.pdf_export_claims;
    v_answer jsonb;
    v_extra jsonb;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_guest := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);

    if v_guest then
        if p_document is null then
            raise exception 'a share-link guest must name the score being exported' using errcode = '22023';
        end if;

        -- document_role() is the caller's membership; the owner is read only
        -- once that is established, so a guest cannot probe whose a score is.
        if public.document_role (p_document) is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;
        select d.owner_id into v_owner
        from public.documents d
        where d.id = p_document;
        if v_owner is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;

        -- tier_limits('student') is unlimited on pdf_exports, so a student
        -- owner's guests fall in the first branch along with every paid plan's.
        v_limit := (public.resolve_entitlements (v_owner) -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'billed_to', 'owner');
        end if;

        v_billed := v_owner;
        v_scope := p_document;
        -- The owner's tier is deliberately not returned: a guest learns that the
        -- allowance ran out, not what the owner pays for.
        v_extra := jsonb_build_object('unlimited', false, 'billed_to', 'owner');
    else
        v_ent := public.get_entitlements ();
        v_tier := v_ent ->> 'tier';

        -- Students print what they were assigned. That is the product working,
        -- not usage to meter.
        if v_tier = 'student' then
            return jsonb_build_object('ok', true, 'exempt', 'student', 'unlimited', true, 'tier', v_tier);
        end if;

        v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'limit', v_limit, 'tier', v_tier);
        end if;

        v_billed := v_user;
        -- An account's export is drawn from its own allowance whatever score it
        -- names, so the score is not part of what a replay must match.
        v_scope := null;
        v_extra := jsonb_build_object('unlimited', false, 'tier', v_tier);
    end if;

    if p_claim is not null then
        -- Claimed first, counted second: a concurrent call with the same id
        -- waits on this row and then sees it, so one id is never counted twice.
        insert into public.pdf_export_claims (id, claimed_by, billed_to, document_id)
        values (p_claim, v_user, v_billed, v_scope)
        on conflict (id) do nothing;

        if not found then
            select c.* into v_prior
            from public.pdf_export_claims c
            where c.id = p_claim;

            if v_prior.claimed_by = v_user
                and v_prior.billed_to = v_billed
                and v_prior.document_id is not distinct from v_scope
                and v_prior.created_at > now() - interval '1 hour' then
                return jsonb_build_object('ok', true, 'limit', v_limit, 'replayed', true) || v_extra;
            end if;

            raise exception 'this export claim has already been used' using errcode = '22023';
        end if;
    end if;

    v_answer := public.consume_quota (v_billed, 'pdf_exports', v_limit);

    -- A refused id bought nothing, so it must not answer ok on a later retry.
    -- Removed in the same transaction that inserted it, it never existed for
    -- anyone else.
    if p_claim is not null and not (v_answer ->> 'ok')::boolean then
        delete from public.pdf_export_claims c where c.id = p_claim;
    end if;

    if v_guest then
        v_answer := v_answer - 'count';
    end if;
    return v_answer || v_extra;
end;
$$;

revoke all on function public.claim_pdf_export (uuid, uuid) from public;
revoke all on function public.claim_pdf_export (uuid, uuid) from anon;
grant execute on function public.claim_pdf_export (uuid, uuid) to authenticated;

-- Redefined only so it is plainly bound to the function above; same body as
-- 20261007120300, so an id-less claim behaves exactly as it always has.
create or replace function public.consume_pdf_export () returns jsonb language sql security definer
set search_path = public as $$
    select public.claim_pdf_export ();
$$;

revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;
