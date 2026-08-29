import { describe, expect, it } from 'vitest';

import { bareAddress, isOwnForward } from '../../supabase/functions/_shared/supportMail';

/**
 * The forward loop guard. We send FROM an address the catch-all also receives
 * at, so without this a bounce or auto-reply aimed at our own From lands back on
 * the endpoint and is forwarded again — the classic runaway forwarder.
 */

describe('bareAddress', () => {
    it.each([
        ['Cleffy support <support@cleffy.io>', 'support@cleffy.io'],
        ['support@cleffy.io', 'support@cleffy.io'],
        ['  SUPPORT@Cleffy.IO  ', 'support@cleffy.io'],
        ['"Quoted, Name" <a.b+tag@sub.example.com>', 'a.b+tag@sub.example.com'],
    ])('reduces %s to %s', (input, expected) => {
        expect(bareAddress(input)).toBe(expected);
    });
});

describe('isOwnForward', () => {
    const FORWARD_FROM = 'Cleffy support <support@cleffy.io>';

    it.each(['support@cleffy.io', 'Cleffy support <support@cleffy.io>', 'SUPPORT@CLEFFY.IO', '<support@cleffy.io>'])(
        'catches our own address as %s',
        (from) => {
            expect(isOwnForward(from, FORWARD_FROM)).toBe(true);
        },
    );

    // A real customer must never be mistaken for the loop.
    it.each([
        'someone@example.com',
        'A Teacher <teacher@school.org>',
        'support@cleffy.io.evil.example',
        'notsupport@cleffy.io',
    ])('lets %s through', (from) => {
        expect(isOwnForward(from, FORWARD_FROM)).toBe(false);
    });
});
