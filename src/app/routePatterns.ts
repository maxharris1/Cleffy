import { matchPath } from 'react-router';

/**
 * Every path routes.tsx declares, as written there. web events and sign-up
 * attribution record which of these a page matched, never the path itself:
 * `/join/:token`, not the invite token. routePatterns.test.ts holds this list
 * equal to routes.tsx, and public.web_route_patterns() (the database copy the
 * server checks against) equal to this list.
 */
export const ROUTE_PATTERNS = [
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
    '/auth/callback',
    '/privacy',
    '/children-privacy',
    '/terms',
    '/cancel',
    '/refunds',
    '/copyright',
    '/report',
    '/account-deleted',
] as const;

/** The route pattern a path matches, or `*` (the not-found route) when none does. */
export const routePatternOf = (pathname: string): string =>
    ROUTE_PATTERNS.find((pattern) => matchPath({ path: pattern, end: true }, pathname)) ?? '*';
