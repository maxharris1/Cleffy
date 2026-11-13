import { describe, expect, it } from 'vitest';

import { legalText, type LegalBlock } from '@/features/legal/legalDocument';
import { PRIVACY_POLICY } from '@/features/legal/privacyPolicy';

/** Every string in one section, or in one sub-heading's blocks of it. */
const sectionText = (id: string, subheading?: string): string => {
    const section = PRIVACY_POLICY.sections.find((s) => s.id === id);
    expect(section, id).toBeDefined();
    let blocks: LegalBlock[] = section!.blocks;
    if (subheading) {
        const start = blocks.findIndex((b) => b.kind === 'h' && b.text === subheading);
        expect(start, subheading).toBeGreaterThanOrEqual(0);
        const end = blocks.findIndex((b, i) => i > start && b.kind === 'h');
        blocks = blocks.slice(start + 1, end === -1 ? undefined : end);
    }
    return legalText({ sections: [{ ...section!, heading: '', blocks }] });
};

describe('the privacy policy discloses first-party web events and campaign tags', () => {
    it('says what is recorded and why, under How we use information', () => {
        expect(sectionText('how-we-use')).toContain(
            'To understand how Cleffy is used and which of our emails and campaigns bring people to it, we record which pages are opened and a few actions (such as opening the demo or signing up), in our own database. We do not record your IP address or browser details, and we do not do this for student accounts or guests.',
        );
    });

    it('says a campaign tag is kept and saved at sign-up, under Technical and security information', () => {
        expect(sectionText('information-we-collect', 'Technical and security information')).toContain(
            'If you arrive from a link that carries a campaign tag (for example utm_campaign=launch_v1), we keep the tag and save it with your account if you sign up.',
        );
    });

    it('lists the tag and the tab number under What Cleffy stores on your device', () => {
        expect(sectionText('device-storage')).toContain(
            'A campaign tag from the link you arrived by, in local storage, for up to 30 days, and a random number for the current tab.',
        );
    });

    it('gives the 13-month limit under How long we keep information', () => {
        expect(sectionText('retention')).toContain('Usage records are deleted after 13 months.');
    });

    it('still says there is no third-party analytics', () => {
        expect(legalText(PRIVACY_POLICY)).toContain('use third-party analytics or advertising trackers');
    });
});
