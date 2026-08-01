-- Row Level Security: owner / editor / viewer via document_members.
-- Design notes (plan §RLS):
--  * document_role() is SECURITY DEFINER so policies never recurse into
--    document_members' own RLS.
--  * Editors may edit/erase ANYONE's annotations (the product requirement) —
--    but inserts must be attributed to the author (created_by = auth.uid()).
--  * No DELETE policy on annotations at all: deletes are tombstone updates.
--  * Anonymous users are role `authenticated` with an is_anonymous JWT claim;
--    they may join/annotate via share links but never create documents.

alter table public.documents enable row level security;

alter table public.document_members enable row level security;

alter table public.share_links enable row level security;

alter table public.annotations enable row level security;

create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select role from public.document_members
    where document_id = doc and user_id = auth.uid();
$$;

grant execute on function public.document_role (uuid) to authenticated;

-- documents ---------------------------------------------------------------
create policy documents_select on public.documents for select to authenticated
using (public.document_role (id) is not null);

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

create policy documents_update on public.documents for update to authenticated
using (public.document_role (id) = 'owner')
with check (owner_id = auth.uid());

create policy documents_delete on public.documents for delete to authenticated
using (public.document_role (id) = 'owner');

-- document_members ----------------------------------------------------------
-- Members can see who else is on a document. NO direct write policies:
-- membership writes happen only via SECURITY DEFINER paths (owner trigger,
-- redeem_share_link).
create policy members_select on public.document_members for select to authenticated
using (public.document_role (document_id) is not null);

-- share_links ---------------------------------------------------------------
create policy share_links_select on public.share_links for select to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_insert on public.share_links for insert to authenticated
with check (
    public.document_role (document_id) = 'owner'
    and created_by = auth.uid()
);

create policy share_links_update on public.share_links for update to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_delete on public.share_links for delete to authenticated
using (public.document_role (document_id) = 'owner');

-- annotations ---------------------------------------------------------------
create policy annotations_select on public.annotations for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = auth.uid()
);

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Share-link redemption -----------------------------------------------------
-- Never reads share_links under the caller's RLS; upserts membership without
-- ever downgrading an existing owner/editor role.
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
declare
    link record;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id, sl.role into link
    from public.share_links sl
    where sl.token = p_token
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now());

    if not found then
        raise exception 'invalid or expired share link' using errcode = 'P0002';
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, auth.uid(), link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end;

    return query
        select link.document_id,
               (select dm.role from public.document_members dm
                where dm.document_id = link.document_id and dm.user_id = auth.uid());
end;
$$;

grant execute on function public.redeem_share_link (text) to authenticated;

-- storage: private 'scores' bucket; object path is '{documentId}/original.pdf'
-- (bucket itself is created via dashboard/API — hosted storage.buckets writes
-- from migrations can hit ownership errors post-lockdown).
create policy scores_read on storage.objects for select to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) is not null
);

create policy scores_insert on storage.objects for insert to authenticated
with check (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_update on storage.objects for update to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);
