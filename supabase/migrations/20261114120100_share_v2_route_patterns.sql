-- Share v2 UI (#105): the app gains /s (a general link, token in the
-- fragment) and /invite (an email invite, token in the fragment).
-- web_route_patterns() stays equal to src/app/routePatterns.ts
-- (routePatterns.test.ts). Neither path ever sends a web event (webEvents
-- excludes both) and boot on /s captures no attribution, so this only keeps
-- the two lists equal. create or replace: safe to run twice.
create or replace function public.web_route_patterns () returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
    select array[
        '/',
        '/login',
        '/register',
        '/forgot-password',
        '/update-password',
        '/student',
        '/student/claim',
        '/student/welcome',
        '/assignments',
        '/library',
        '/search',
        '/students',
        '/account',
        '/admin/reports',
        '/settings',
        '/doc/:documentId',
        '/try',
        '/join/:token',
        '/s',
        '/invite',
        '/auth/callback',
        '/privacy',
        '/children-privacy',
        '/terms',
        '/cancel',
        '/refunds',
        '/copyright',
        '/report',
        '/account-deleted'
    ]::text[]
$$;

revoke all on function public.web_route_patterns () from public, anon, authenticated;

grant execute on function public.web_route_patterns () to service_role;
