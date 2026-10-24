-- An archived student who signs in is told they were archived.
--
-- Archiving bans the student's auth account (student-provision), and GoTrue's
-- password grant refuses a banned account BEFORE it checks the password. So
-- student-login could only ever answer an archived student with its one
-- floored "That username and password did not work" -- at a password that is
-- right, which the student then retypes forever, and which also wiped the
-- "your teacher changed your access / your changes are kept" notice the app
-- had just shown them.
--
-- Saying "archived" to anyone who typed an archived username would make the
-- endpoint an oracle for which usernames exist (handler.ts explains why it has
-- one rejection). Saying it to someone who typed that account's PASSWORD tells
-- them nothing they do not already hold. GoTrue will not check that password
-- for a banned account, so this does: bcrypt, through pgcrypto's crypt(),
-- against the hash GoTrue stored.
--
-- Only for an archived, claimed roster row whose auth user is a provisioned
-- student (the same filters student-login applies to a live row, archived
-- flipped). Anything else, a non-bcrypt hash, or an error is false, which
-- student-login answers exactly as before. The service role alone may call it:
-- to anyone else it would be an unthrottled password check. student-login has
-- already counted the attempt against its per-username and per-address limits
-- before it gets here.
create or replace function public.archived_student_password_matches (p_username text, p_password text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_hash text;
begin
    if coalesce(auth.role (), '') <> 'service_role' then
        raise exception 'archived_student_password_matches is for the service role only' using errcode = '42501';
    end if;
    if p_username is null or p_password is null or p_password = '' then
        return false;
    end if;

    select u.encrypted_password into v_hash
    from public.managed_students ms
    join auth.users u on u.id = ms.student_user_id
    where ms.username = p_username
      and ms.archived_at is not null
      and ms.claimed_at is not null
      and coalesce(u.raw_app_meta_data ->> 'user_type', '') = 'student';

    -- GoTrue stores bcrypt ($2a$, or $2b$/$2y$ from elsewhere). Anything else
    -- is not a hash crypt() can check here.
    if v_hash is null or v_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
        return false;
    end if;

    begin
        return extensions.crypt (p_password, v_hash) = v_hash;
    exception when others then
        return false;
    end;
end;
$$;

revoke all on function public.archived_student_password_matches (text, text) from public, anon, authenticated;
grant execute on function public.archived_student_password_matches (text, text) to service_role;
