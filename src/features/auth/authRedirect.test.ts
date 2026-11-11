import { afterEach, describe, expect, it, vi } from 'vitest';

import { loginPathWithNext, parseAuthNext, registeredGuestPath } from '@/features/auth/authRedirect';

const standalone = vi.hoisted(() => ({ value: false }));

vi.mock('@/features/install/installSurface', () => ({
    isStandaloneDisplay: () => standalone.value,
}));

afterEach(() => {
    standalone.value = false;
});

describe('parseAuthNext', () => {
    it('allows library and assignments and rejects everything else', () => {
        expect(parseAuthNext('/library')).toBe('/library');
        expect(parseAuthNext('/assignments')).toBe('/assignments');
        expect(parseAuthNext(null)).toBe('/library');
        expect(parseAuthNext('https://evil.example/')).toBe('/library');
        expect(parseAuthNext('//evil.example')).toBe('/library');
        expect(parseAuthNext('/login')).toBe('/library');
    });
});

describe('loginPathWithNext', () => {
    it('encodes the next path on /login', () => {
        expect(loginPathWithNext('/library')).toBe('/login?next=%2Flibrary');
        expect(loginPathWithNext('/assignments')).toBe('/login?next=%2Fassignments');
    });
});

describe('registeredGuestPath', () => {
    it('keeps the browser fallback on a normal tab', () => {
        expect(registeredGuestPath('/')).toBe('/');
        expect(registeredGuestPath('/login')).toBe('/login');
    });

    it('sends a standalone guest to login with next=/library', () => {
        standalone.value = true;
        expect(registeredGuestPath('/')).toBe('/login?next=%2Flibrary');
    });

    it('does not override an explicit /login fallback (password recovery)', () => {
        standalone.value = true;
        expect(registeredGuestPath('/login')).toBe('/login');
        expect(registeredGuestPath('/login?next=%2Flibrary')).toBe('/login?next=%2Flibrary');
    });
});
