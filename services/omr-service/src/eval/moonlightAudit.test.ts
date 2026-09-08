import { describe, expect, it } from 'vitest';

import { moonlightAuditResult } from './moonlightAudit.js';

describe('moonlightAuditResult', () => {
    it('reproduces the 2026-09-07 headline pitch matches', () => {
        const result = moonlightAuditResult();
        expect(result.movements[0]?.pitchMatch).toBeCloseTo(68.5, 1);
        expect(result.movements[1]?.pitchMatch).toBeCloseTo(92.2, 1);
        expect(result.movements[2]?.pitchMatch).toBeCloseTo(75.5, 1);
        expect(result.overall.missing).toBe(1043);
    });
});
