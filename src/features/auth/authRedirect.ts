import { isStandaloneDisplay } from '@/features/install/installSurface';

/** In-app destinations LoginPage will honor after a successful sign-in. */
export type AuthNextPath = '/library' | '/assignments';

export const DEFAULT_AUTH_NEXT: AuthNextPath = '/library';

export const parseAuthNext = (raw: string | null | undefined): AuthNextPath => {
    if (raw === '/assignments') {
        return '/assignments';
    }
    return DEFAULT_AUTH_NEXT;
};

export const loginPathWithNext = (next: AuthNextPath): string => {
    switch (next) {
        case '/library':
            return '/login?next=%2Flibrary';
        case '/assignments':
            return '/login?next=%2Fassignments';
        default: {
            const _never: never = next;
            return _never;
        }
    }
};

/**
 * Where RequireRegistered sends a guest.
 *
 * Browser tabs keep the marketing landing (`fallback`, usually `/`). An
 * installed Home Screen app must not: its start_url is `/library`, and the
 * landing header is easy to miss under the iPhone status bar. Send them to
 * login with `next` so sign-in returns to the library (or assignments).
 */
export const registeredGuestPath = (fallback: string): string => {
    if (!isStandaloneDisplay()) {
        return fallback;
    }
    if (fallback === '/login' || fallback.startsWith('/login?')) {
        return fallback;
    }
    return loginPathWithNext(DEFAULT_AUTH_NEXT);
};
