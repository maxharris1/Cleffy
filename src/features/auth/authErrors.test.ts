import { describe, expect, it } from 'vitest';

import { mapAuthError } from '@/features/auth/authErrors';

describe('mapAuthError', () => {
    it('maps by Auth error code', () => {
        expect(mapAuthError({ code: 'invalid_credentials', message: 'noise' })).toBe(
            'Email or password is incorrect.',
        );
        expect(mapAuthError({ code: 'user_already_exists', message: 'noise' })).toBe(
            'An account with this email already exists. Try signing in.',
        );
        expect(mapAuthError({ code: 'over_email_send_rate_limit', message: 'noise' })).toBe(
            'Too many attempts. Try again later.',
        );
        expect(mapAuthError({ code: 'otp_expired', message: 'noise' })).toBe(
            'This link has expired. Request a new one.',
        );
    });

    it('maps legacy / URL message patterns when code is absent', () => {
        expect(mapAuthError('Invalid login credentials')).toBe('Email or password is incorrect.');
        expect(mapAuthError('User already registered')).toBe(
            'An account with this email already exists. Try signing in.',
        );
        expect(mapAuthError('Email link is invalid or has expired')).toBe(
            'This link has expired. Request a new one.',
        );
    });

    it('uses Error.code when present', () => {
        const err = Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' });
        expect(mapAuthError(err)).toBe('Email or password is incorrect.');
    });

    it('falls back for unknown errors (no raw vendor passthrough)', () => {
        expect(mapAuthError({ message: 'Custom failure' })).toBe('Something went wrong.');
        expect(mapAuthError({})).toBe('Something went wrong.');
        expect(mapAuthError({}, 'Nope')).toBe('Nope');
        expect(mapAuthError('something obscure')).toBe('Something went wrong.');
    });
});
