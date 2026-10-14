import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatUpdated } from '@/features/library/libraryFormat';

afterEach(() => {
    vi.useRealTimers();
});

describe('formatUpdated', () => {
    it('says Today and Yesterday for the last two days', () => {
        vi.useFakeTimers({ now: new Date(2026, 9, 14, 15, 0) });
        expect(formatUpdated(new Date(2026, 9, 14, 9, 30).toISOString())).toBe('Today');
        expect(formatUpdated(new Date(2026, 9, 13, 22, 0).toISOString())).toBe('Yesterday');
    });

    it('formats older dates exactly as toLocaleDateString did, with the year only outside this one', () => {
        vi.useFakeTimers({ now: new Date(2026, 9, 14, 15, 0) });
        const march = new Date(2026, 2, 4, 12, 0);
        const lastYear = new Date(2025, 11, 31, 12, 0);
        expect(formatUpdated(march.toISOString())).toBe(
            march.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        );
        expect(formatUpdated(lastYear.toISOString())).toBe(
            lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
        );
    });

    it('is empty for a date it cannot read', () => {
        expect(formatUpdated('not a date')).toBe('');
    });
});
