import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgeGate } from '@/features/auth/ageCheck';
import { signUpWithPassword } from '@/features/auth/session';
import { captureAttribution, readAttribution, resetAttributionForTests } from '@/lib/attribution';

const h = vi.hoisted(() => ({ signUp: vi.fn(), track: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ auth: { signUp: h.signUp } }),
    isSupabaseConfigured: () => true,
}));

vi.mock('@/lib/webEvents', () => ({ track: h.track }));

const gate = { country: 'US', min_age: 13, source: 'self', v: 1 } as unknown as AgeGate;

beforeEach(() => {
    h.signUp.mockReset();
    h.track.mockReset();
    window.localStorage.clear();
    resetAttributionForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

const sentData = () => (h.signUp.mock.calls[0]![0] as { options: { data: Record<string, unknown> } }).options.data;

describe('signUpWithPassword and attribution', () => {
    it('sends the first-touch attribution next to age_gate, and counts the sign-up', async () => {
        captureAttribution({ pathname: '/try', search: '?utm_campaign=launch_v1&utm_content=hero_a' });
        h.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });

        await expect(signUpWithPassword('a@example.com', 'pw-123456', null, gate)).resolves.toEqual({
            needsEmailConfirmation: true,
        });

        expect(sentData()).toEqual({ age_gate: gate, attribution: readAttribution() });
        expect(sentData()['attribution']).toEqual(
            expect.objectContaining({ utm_campaign: 'launch_v1', utm_content: 'hero_a', landing_path: '/try' }),
        );
        expect(h.track).toHaveBeenCalledTimes(1);
        expect(h.track).toHaveBeenCalledWith('signup_completed');
    });

    it('sends no attribution key for a visitor who arrived with no tag', async () => {
        h.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
        await signUpWithPassword('a@example.com', 'pw-123456', null, gate);
        expect(JSON.parse(JSON.stringify(sentData()))).toEqual({ age_gate: gate });
    });

    it('counts nothing when the sign-up fails', async () => {
        h.signUp.mockResolvedValue({ data: { session: null, user: null }, error: new Error('nope') });
        await expect(signUpWithPassword('a@example.com', 'pw-123456', null, gate)).rejects.toThrow('nope');
        expect(h.track).not.toHaveBeenCalled();
    });
});
