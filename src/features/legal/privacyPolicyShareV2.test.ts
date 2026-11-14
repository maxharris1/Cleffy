import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as FeaturesModule from '@/lib/features';

const loadPolicy = async (shareV2: boolean) => {
    vi.resetModules();
    vi.doMock('@/lib/features', async (importOriginal) => {
        const actual = await importOriginal<typeof FeaturesModule>();
        return { features: { ...actual.features, shareV2 } };
    });
    const { PRIVACY_POLICY } = await import('@/features/legal/privacyPolicy');
    const { legalText } = await import('@/features/legal/legalDocument');
    const section = (id: string): string => {
        const found = PRIVACY_POLICY.sections.find((candidate) => candidate.id === id);
        expect(found, id).toBeDefined();
        return legalText({ sections: found ? [found] : [] });
    };
    return { text: legalText(PRIVACY_POLICY), section };
};

afterEach(() => {
    vi.doUnmock('@/lib/features');
    vi.resetModules();
});

describe('the Privacy Policy with Share v2 on', () => {
    it('says what viewing, editing and invites collect, in place of the guest name line', async () => {
        const { text, section } = await loadPolicy(true);
        const collected = section('information-we-collect');
        expect(collected).toMatch(
            /Viewing by link: you do not need an account, nothing is asked and nothing about you is stored\./,
        );
        expect(collected).toMatch(/Vercel and Supabase process your IP address .*\(about 7 days at most\)/);
        expect(collected).toMatch(/“Anonymous Otter”, and the owner sees how many people are viewing, but not who\./);
        expect(collected).toMatch(/Editing by link: you can give a name or stay anonymous\./);
        expect(collected).toMatch(
            /owner chooses, between 7 and 90 days \(30 days unless they change it\)\. Your markings stay on the score\./,
        );
        expect(collected).toMatch(
            /Invites: .* stored until it is accepted or expires \(after 14 days\), then deleted 30 days later\./,
        );
        expect(collected).toMatch(/^When you sign up, the country you choose/m);
        expect(text).not.toMatch(/with the name you type/);
        expect(text).not.toMatch(/join as a guest/);
    });

    it('describes link expiry, renew and reset, anonymous viewers and the viewer count', async () => {
        const { section } = await loadPolicy(true);
        const seen = section('who-can-see');
        expect(seen).toMatch(/from 1 hour to 1 year \(7 days by default\), or never if the owner chooses that/);
        expect(seen).toMatch(/The owner can renew a link, or reset it/);
        expect(seen).toMatch(/Revoked or expired links are deleted 30 days later\./);
        expect(seen).toMatch(/anonymous viewer, such as “Anonymous Otter”, and the owner sees a live count/);
        expect(seen).toMatch(/email addresses are never shown/);
    });

    it('asks the age question at account creation only', async () => {
        const { section } = await loadPolicy(true);
        const children = section('children');
        expect(children).toMatch(/To create an account, you must be at least 13/);
        expect(children).toMatch(
            /Opening or editing a shared score by link does not create an account; if you later want to keep your work in an account, we ask the age question then\./,
        );
        expect(children).not.toMatch(/join a score as a guest/);
    });

    it('keeps link guests for the owner-chosen window and other guests for 90 days', async () => {
        const { section } = await loadPolicy(true);
        const retention = section('retention');
        expect(retention).toMatch(/owner chooses, between 7 and 90 days \(30 days by default;/);
        expect(retention).toMatch(/Other guest profiles are deleted after 90 days without use\./);
        expect(retention).toMatch(/deleted 30 days after they expire or are revoked/);
        expect(retention).toMatch(/Email invitations expire after 14 days and are deleted 30 days after/);
        expect(retention).not.toMatch(/created through a share link are deleted after 90 days/);
    });
});

describe('the Privacy Policy with Share v2 off', () => {
    it('keeps the guest join lines', async () => {
        const { text } = await loadPolicy(false);
        expect(text).toMatch(/a temporary guest session is created with the name you type/);
        expect(text).toMatch(/Guest profiles created through a share link are deleted after 90 days without use/);
        expect(text).not.toMatch(/Viewing by link|Anonymous Otter|1 hour to 1 year/);
    });
});
