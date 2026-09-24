import { describe, expect, it } from 'vitest';

import { isSymbolicFirstEnabled } from './flag.js';

describe('isSymbolicFirstEnabled', () => {
    it('is off when unset (prod default)', () => {
        expect(isSymbolicFirstEnabled(undefined)).toBe(false);
        expect(isSymbolicFirstEnabled('')).toBe(false);
        expect(isSymbolicFirstEnabled('  ')).toBe(false);
    });

    it('treats 1/true/on/yes as on (eval)', () => {
        expect(isSymbolicFirstEnabled('1')).toBe(true);
        expect(isSymbolicFirstEnabled('TRUE')).toBe(true);
        expect(isSymbolicFirstEnabled('on')).toBe(true);
        expect(isSymbolicFirstEnabled('yes')).toBe(true);
    });

    it('treats 0/false/off/no/unknown as off', () => {
        expect(isSymbolicFirstEnabled('0')).toBe(false);
        expect(isSymbolicFirstEnabled('false')).toBe(false);
        expect(isSymbolicFirstEnabled('off')).toBe(false);
        expect(isSymbolicFirstEnabled('maybe')).toBe(false);
    });
});
