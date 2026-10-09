import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { mapAuthError, passwordResetProblem } from '@/features/auth/authErrors';

describe('mapAuthError', () => {
    it('maps by Auth error code', () => {
        expect(mapAuthError({ code: 'invalid_credentials', message: 'noise' })).toBe('Email or password is incorrect.');
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
        expect(mapAuthError('Email link is invalid or has expired')).toBe('This link has expired. Request a new one.');
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

describe('mapAuthError — password policy refusals', () => {
    it('names the policy when the server calls a password weak', () => {
        expect(mapAuthError({ code: 'weak_password', message: 'Password should contain at least one character' })).toBe(
            'That password is too weak. At least 8 characters, with a letter and a number.',
        );
    });

    it('says "breached" rather than repeating rules a breached password already meets', () => {
        const err = Object.assign(new Error('Password is known to be weak'), {
            code: 'weak_password',
            reasons: ['pwned'],
        });
        expect(mapAuthError(err)).toBe('That password has appeared in a data breach. Choose a different one.');
    });

    it('maps same_password', () => {
        expect(mapAuthError({ code: 'same_password', message: 'noise' })).toBe(
            'Choose a password different from your current one.',
        );
    });
});

describe('passwordResetProblem', () => {
    it('answers neutrally for anything only an existing account can cause', () => {
        // The per-address resend limit: only an account has a last-sent time.
        expect(
            passwordResetProblem(
                new AuthApiError(
                    'For security purposes, you can only request this after 52 seconds.',
                    429,
                    'over_email_send_rate_limit',
                ),
            ),
        ).toBeNull();
        // The account's mail could not be sent.
        expect(
            passwordResetProblem(new AuthApiError('Error sending recovery email', 500, 'unexpected_failure')),
        ).toBeNull();
        expect(passwordResetProblem(new Error('something else entirely'))).toBeNull();
    });

    it('tells the person to wait when the request rate is limited for everyone', () => {
        expect(
            passwordResetProblem(new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit')),
        ).toMatch(/Wait a few minutes/);
        expect(
            passwordResetProblem(new AuthApiError('Email rate limit exceeded', 429, 'over_email_send_rate_limit')),
        ).toMatch(/Wait a few minutes/);
    });

    it('reports an address GoTrue will not take, and a request that never got an answer', () => {
        expect(
            passwordResetProblem(
                new AuthApiError('Unable to validate email address: invalid format', 400, 'validation_failed'),
            ),
        ).toBe('Enter a valid email address.');
        expect(passwordResetProblem(new AuthRetryableFetchError('Failed to fetch', 0))).toMatch(
            /Check your connection/,
        );
    });
});
