import { afterEach, describe, expect, it, vi } from 'vitest';

import { presenceNameOf } from '@/features/auth/session';
import { anonymousName } from '@/features/share/anonymousAnimals';
import { presenceLabel, safePresenceName } from '@/lib/presenceName';
import type { PresencePeer } from '@/sync/wire';

const flags = vi.hoisted(() => ({ shareV2: false }));
vi.mock('@/lib/features', () => ({ features: flags }));

const sessionWith = (meta: Record<string, unknown>, isAnonymous = false, email = 'teacher@example.com') =>
    ({ user: { id: 'guest-1', user_metadata: meta, is_anonymous: isAnonymous, email } }) as unknown as Parameters<
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

describe('Share v2 presence names', () => {
    afterEach(() => {
        flags.shareV2 = false;
    });

    it('a link guest with no name is Anonymous <animal> with the flag on, Guest with it off', () => {
        expect(presenceNameOf(sessionWith({}, true, ''))).toBe('Guest');
        flags.shareV2 = true;
        expect(presenceNameOf(sessionWith({}, true, ''))).toBe(anonymousName('guest-1'));
        expect(presenceNameOf(sessionWith({ display_name: 'Sam' }, true, ''))).toBe('Sam');
        expect(presenceNameOf(sessionWith({}))).toBe('Collaborator');
    });

    const peer = (userId: string, name: string, isAnonymous = false): PresencePeer => ({
        userId,
        name,
        isAnonymous,
        color: '#000',
        page: 0,
    });

    it('relabels a non-member as Anonymous <animal> whatever name it claims (R4)', () => {
        const members = new Set(['owner-1', 'editor-1']);
        expect(presenceLabel(peer('stranger', 'Ms Rivera (teacher)'), members)).toBe(anonymousName('stranger'));
        expect(presenceLabel(peer('editor-1', 'Leo'), members)).toBe('Leo');
        expect(presenceLabel(peer('editor-1', 'leo@example.com'), members)).toBe('Collaborator');
    });

    it('with no member list the announced name stands', () => {
        expect(presenceLabel(peer('stranger', 'Sam', true), null)).toBe('Sam');
    });
});
