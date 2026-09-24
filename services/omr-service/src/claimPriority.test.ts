import { afterEach, describe, expect, it } from 'vitest';

import {
    CLAIM_MAX_PRIORITY_ENV,
    claimMaxPriority,
    claimMaxPriorityMisconfigured,
    parseClaimMaxPriority,
} from './claimPriority.js';

const original = process.env[CLAIM_MAX_PRIORITY_ENV];

afterEach(() => {
    if (original === undefined) {
        delete process.env[CLAIM_MAX_PRIORITY_ENV];
    } else {
        process.env[CLAIM_MAX_PRIORITY_ENV] = original;
    }
});

describe('parseClaimMaxPriority', () => {
    it('is null (no filter) when unset or blank', () => {
        expect(parseClaimMaxPriority(undefined)).toBeNull();
        expect(parseClaimMaxPriority('')).toBeNull();
        expect(parseClaimMaxPriority('   ')).toBeNull();
    });

    it('parses integers including the seed pool value -1', () => {
        expect(parseClaimMaxPriority('-1')).toBe(-1);
        expect(parseClaimMaxPriority(' -10 ')).toBe(-10);
        expect(parseClaimMaxPriority('0')).toBe(0);
        expect(parseClaimMaxPriority('+5')).toBe(5);
    });

    it('rejects anything that is not an integer instead of guessing', () => {
        expect(parseClaimMaxPriority('-1.5')).toBeNull();
        expect(parseClaimMaxPriority('seed')).toBeNull();
        expect(parseClaimMaxPriority('1e3')).toBeNull();
        expect(parseClaimMaxPriority('0x10')).toBeNull();
    });
});

describe('claimMaxPriority / claimMaxPriorityMisconfigured', () => {
    it('reads the live env at call time', () => {
        delete process.env[CLAIM_MAX_PRIORITY_ENV];
        expect(claimMaxPriority()).toBeNull();
        expect(claimMaxPriorityMisconfigured()).toBe(false);

        process.env[CLAIM_MAX_PRIORITY_ENV] = '-1';
        expect(claimMaxPriority()).toBe(-1);
        expect(claimMaxPriorityMisconfigured()).toBe(false);
    });

    it('flags a set-but-invalid value so server startup can refuse it', () => {
        process.env[CLAIM_MAX_PRIORITY_ENV] = 'yes';
        expect(claimMaxPriority()).toBeNull();
        expect(claimMaxPriorityMisconfigured()).toBe(true);
        expect(claimMaxPriorityMisconfigured('')).toBe(false);
        expect(claimMaxPriorityMisconfigured('-1')).toBe(false);
    });
});
