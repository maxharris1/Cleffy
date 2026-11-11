import { describe, expect, it } from 'vitest';

import { bareAddress, forwardedSubject, inboxTagFor, isOwnForward } from '../../supabase/functions/_shared/supportMail';

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

describe('inboxTagFor', () => {
    it.each([
        [['privacy@cleffy.io'], [], 'privacy'],
        [['legal@cleffy.io'], [], 'legal'],
        [['support@cleffy.io'], [], 'support'],
        [['Cleffy Privacy <PRIVACY@cleffy.io>'], [], 'privacy'],
    ])('tags mail received for %s as %s', (receivedFor, to, tag) => {
        expect(inboxTagFor(receivedFor, to)).toBe(tag);
    });

    it('falls back to the To addresses when Resend gives no received_for', () => {
        expect(inboxTagFor([], ['someone@else.example', 'legal@cleffy.io'])).toBe('legal');
    });

    it('takes the most sensitive inbox when a message reached several', () => {
        expect(inboxTagFor(['support@cleffy.io', 'privacy@cleffy.io', 'legal@cleffy.io'])).toBe('privacy');
        expect(inboxTagFor(['support@cleffy.io', 'legal@cleffy.io'])).toBe('legal');
    });

    it('calls anything else support', () => {
        expect(inboxTagFor(['billing@cleffy.io'])).toBe('support');
        expect(inboxTagFor()).toBe('support');
    });
});

describe('forwardedSubject', () => {
    it('puts the tag in front of the sender’s subject', () => {
        expect(forwardedSubject('privacy', 'Please delete my data')).toBe('[privacy] Please delete my data');
        expect(forwardedSubject('support', '  ')).toBe('[support] (no subject)');
        expect(forwardedSubject('legal', undefined)).toBe('[legal] (no subject)');
    });
});
