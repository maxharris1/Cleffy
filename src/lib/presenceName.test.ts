import { describe, expect, it } from 'vitest';

import { presenceNameOf } from '@/features/auth/session';
import { safePresenceName } from '@/lib/presenceName';

const sessionWith = (meta: Record<string, unknown>, isAnonymous = false, email = 'teacher@example.com') =>
    ({ user: { user_metadata: meta, is_anonymous: isAnonymous, email } }) as unknown as Parameters<
        typeof presenceNameOf
    >[0];

describe('presence names never show an email', () => {
    it('uses the display name when there is one', () => {
        expect(presenceNameOf(sessionWith({ display_name: '  Ms Rivera ' }))).toBe('Ms Rivera');
    });

    it('falls back to Collaborator for an account without one, not to its email', () => {
        expect(presenceNameOf(sessionWith({}))).toBe('Collaborator');
        expect(presenceNameOf(sessionWith({ display_name: '' }))).toBe('Collaborator');
    });

    it('falls back to Guest for a share-link guest', () => {
        expect(presenceNameOf(sessionWith({}, true, ''))).toBe('Guest');
    });

    it('treats a display name that is an email address as no name', () => {
        expect(presenceNameOf(sessionWith({ display_name: 'teacher@example.com' }))).toBe('Collaborator');
    });

    it('cleans what an older build announces about someone else', () => {
        expect(safePresenceName('parent@example.org', false)).toBe('Collaborator');
        expect(safePresenceName('kid@example.org', true)).toBe('Guest');
        expect(safePresenceName('Sharon', true)).toBe('Sharon');
    });
});
