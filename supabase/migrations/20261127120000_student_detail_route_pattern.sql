-- One student's page (#198): the app gains /students/:studentId.
-- web_route_patterns() stays equal to src/app/routePatterns.ts
-- (routePatterns.test.ts). The pattern carries no student id, so a page view
-- records which page was seen, never whose. create or replace: safe to run twice.
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
        '/students/:studentId',
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
