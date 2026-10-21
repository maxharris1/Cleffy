import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { sendsToAnthropic } from '@/features/legal/aiFeatures';
import {
    COPYRIGHT_POLICY,
    LEGAL_DOCUMENTS,
    LEGAL_DOCUMENTS_ARE_DRAFTS,
    LEGAL_ENTITY,
    LEGAL_VERSIONS,
    PRIVACY_POLICY,
    REFUND_POLICY,
    TERMS_OF_SERVICE,
    legalText,
    type LegalDocument,
} from '@/features/legal/legalContent';
import { CopyrightPolicyPage, PrivacyPage, RefundPolicyPage, TermsPage } from '@/features/legal/LegalPage';
import { LEGAL_DOCUMENT_IDS } from '@/features/legal/legalVersions';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { clearCloudAnnotationData } from '@/sync/signOutSync';
import type { Annotation } from '@/types/models';

const sectionText = (doc: LegalDocument, id: string): string => {
    const section = doc.sections.find((candidate) => candidate.id === id);
    return section ? legalText({ sections: [section] }) : '';
};

const CLOUD_DOC = 'c0ffee00-0000-4000-8000-0000000000aa';
const DEVICE_DOC = 'local-0123456789abcdef';

const unsyncedMark = (id: string, docId: string): Annotation => ({
    id,
    docId,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

describe('legal content', () => {
    it.each(LEGAL_DOCUMENT_IDS.map((id) => [id, LEGAL_DOCUMENTS[id]] as const))(
        '%s has unique, linkable section ids and names the operator and a way to reach us',
        (id, doc) => {
            expect(doc.id).toBe(id);
            const ids = doc.sections.map((section) => section.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const sectionId of ids) {
                expect(sectionId).toMatch(/^[a-z][a-z-]*$/);
            }
            const text = `${doc.summary}\n${legalText(doc)}`;
            expect(text).toContain(LEGAL_ENTITY.name);
            expect(text).toMatch(/support@cleffy\.io|legal@cleffy\.io/);
            expect(text).not.toMatch(/TODO|TBD|lorem/i);
        },
    );

    it('names Cleffy LLC with its New York address as the operator', () => {
        expect(LEGAL_ENTITY.name).toBe('Cleffy LLC');
        expect(LEGAL_ENTITY.postalAddress).toBe('245 East 37th Street, Apt 3E, New York, NY 10016, USA');
        expect(LEGAL_ENTITY.emails).toEqual({
            legal: 'legal@cleffy.io',
            privacy: 'privacy@cleffy.io',
            support: 'support@cleffy.io',
        });
        for (const doc of [PRIVACY_POLICY, TERMS_OF_SERVICE]) {
            expect(legalText(doc)).toContain(LEGAL_ENTITY.postalAddress);
        }
    });

    it('marks every document as a draft with placeholders while counsel has the text', () => {
        expect(LEGAL_DOCUMENTS_ARE_DRAFTS).toBe(true);
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(LEGAL_VERSIONS[id], id).toMatch(/^\d{4}-\d{2}-\d{2}-draft$/);
        }
        for (const doc of [PRIVACY_POLICY, TERMS_OF_SERVICE, REFUND_POLICY, COPYRIGHT_POLICY]) {
            const placeholders = doc.sections.flatMap((section) =>
                section.blocks.filter((block) => block.kind === 'placeholder'),
            );
            expect(placeholders.length, doc.id).toBeGreaterThan(0);
        }
    });

    it('names every processor the code actually sends data to', () => {
        const text = legalText(PRIVACY_POLICY);
        for (const processor of ['Supabase', 'Vercel', 'Stripe', 'Resend', 'Sentry']) {
            expect(text).toContain(processor);
        }
    });

    it('does not mention Anthropic while smart import is off', () => {
        // The test build sets no VITE_FEATURE_* variable, as production does
        // at launch: smart import, fingering and play-along are all off.
        expect(sendsToAnthropic).toBe(false);
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(legalText(LEGAL_DOCUMENTS[id]), id).not.toMatch(/Anthropic|Claude/);
        }
    });

    it('describes only the AI features this build ships', () => {
        const text = legalText(PRIVACY_POLICY);
        expect(text).not.toContain('Smart import');
        expect(text).not.toContain('Fingering suggestions');
        expect(text).not.toContain('Play-along');
        expect(text).not.toContain('Google Cloud');
        expect(PRIVACY_POLICY.sections.map((section) => section.id)).not.toContain('ai');
        expect(TERMS_OF_SERVICE.sections.map((section) => section.id)).not.toContain('ai-features');
    });

    it('names the confirmed hosting region', () => {
        expect(LEGAL_ENTITY.dataRegion).toBe('United States (AWS us-west-2, Oregon)');
        expect(legalText(PRIVACY_POLICY)).toContain(
            'hosted on Amazon Web Services in the United States (AWS us-west-2, Oregon)',
        );
    });

    it('states the retention periods the product decided', () => {
        const text = sectionText(PRIVACY_POLICY, 'retention');
        expect(text).toMatch(/Archived student accounts are deleted 12 months after/);
        expect(text).toMatch(/Guest profiles .* are deleted after 90 days/);
        expect(text).toMatch(/kept for 24 months/);
        expect(text).toMatch(/deleted 30 days after its contract ends/);
    });

    it('states the age limits: 13, or up to 16 where a country requires', () => {
        for (const text of [sectionText(PRIVACY_POLICY, 'children'), sectionText(TERMS_OF_SERVICE, 'accounts')]) {
            expect(text).toMatch(/at least 13/);
            expect(text).toMatch(/up to 16/);
        }
    });

    it('never says presence shows an email address', () => {
        const text = sectionText(PRIVACY_POLICY, 'who-can-see');
        expect(text).toMatch(/email addresses are never shown/);
        expect(text).not.toMatch(/your email address if you have not set one/);
        // The fallbacks are the ones #64's safePresenceName() uses, never an address.
        expect(text).toMatch(/shown as “Collaborator”, or “Guest” for a guest/);
    });

    it('has no document that lets presence fall back to an email address', () => {
        // Presence is what other viewers of a score see. dev's single
        // legalContent.ts said it showed "your email address if you have not
        // set one"; no policy may say that again, whichever file the text
        // moves to.
        for (const [id, doc] of Object.entries(LEGAL_DOCUMENTS)) {
            const sentences = legalText(doc)
                .split(/(?<=[.;])\s+|\n/)
                .filter((sentence) => /see each other|viewing it|presence/i.test(sentence));
            for (const sentence of sentences) {
                expect(sentence, id).not.toMatch(/email address(?!es are never shown)/i);
            }
        }
    });

    it('describes sign-out as session.ts and signOutSync.ts do it', async () => {
        // The behaviour the paragraph must describe, run for real: an unsynced
        // change on a cloud score does not survive sign-out's clear; one on a
        // file opened from the device does.
        const db = new ScribblerDb(`legal-sign-out-${crypto.randomUUID()}`);
        await new AnnotationStore(db, CLOUD_DOC).create(unsyncedMark('cloud-mark', CLOUD_DOC));
        await new AnnotationStore(db, DEVICE_DOC).create(unsyncedMark('device-mark', DEVICE_DOC));
        await clearCloudAnnotationData(db);
        expect((await db.ops.toArray()).map((op) => op.annotationId)).toEqual(['device-mark']);
        expect((await db.annotations.toArray()).map((row) => row.id)).toEqual(['device-mark']);
        db.close();

        // So the policy must not promise unsynced work survives: signOut()
        // clears it after syncBeforeSignOut uploads what it can and
        // useGuardedSignOut warns about the rest.
        const text = sectionText(PRIVACY_POLICY, 'device-storage');
        expect(text).toMatch(/Signing out first uploads any markings and changes that have not finished syncing/);
        expect(text).toMatch(/tells you before going ahead, and if you sign out anyway they are lost/);
        expect(text).toMatch(/the device’s copy of your markings/);
        expect(text).toMatch(/Markings on files you opened from your device without uploading them stay/);
        expect(text).not.toMatch(/are kept, so no work is lost/);
    });

    it('explains what account deletion does, matching delete-account', () => {
        const text = sectionText(PRIVACY_POLICY, 'deleting');
        expect(text).toMatch(/subscription is cancelled/);
        expect(text).toMatch(/Student accounts you created are deleted/);
        expect(text).toMatch(/stay there, no longer attributed to you/);
        expect(text).toMatch(/cannot be undone/);
        // Guests delete themselves too (ShareDialog → delete-account's guest path).
        expect(text).toMatch(/delete that guest profile from the score’s Sharing panel/);
    });
});

describe('the refund policy', () => {
    it('gives everyone a full refund within 14 days of their first purchase, with no waiver', () => {
        const text = sectionText(REFUND_POLICY, 'fourteen-days');
        expect(text).toMatch(/Wherever you live/);
        expect(text).toMatch(/full refund within 14 days of your first purchase/);
        expect(text).toMatch(/do not lose this right by using/);
        expect(legalText(REFUND_POLICY)).toMatch(/We do not ask you to give up this right/);
    });

    it('carries the EU/UK withdrawal information and the model withdrawal form', () => {
        expect(sectionText(REFUND_POLICY, 'withdrawal')).toMatch(
            /You have the right to withdraw from this contract within 14 days without giving any reason/,
        );
        expect(sectionText(REFUND_POLICY, 'effects-of-withdrawal')).toMatch(/not later than 14 days/);
        const annex = REFUND_POLICY.sections.find((section) => section.id === 'model-withdrawal-form');
        expect(annex?.heading).toBe('Annex A — Model withdrawal form');
        const form = annex?.blocks.find((block) => block.kind === 'form');
        expect(form?.kind === 'form' ? form.lines[0] : '').toBe(
            `To: ${LEGAL_ENTITY.name}, ${LEGAL_ENTITY.postalAddress}, ${LEGAL_ENTITY.emails.support}`,
        );
    });

    it('is what the terms point to', () => {
        expect(sectionText(TERMS_OF_SERVICE, 'plans-and-billing')).toMatch(/full refund within 14 days/);
        expect(sectionText(TERMS_OF_SERVICE, 'plans-and-billing')).not.toMatch(/payments are not refundable/);
    });
});

describe('the terms', () => {
    it('include the School Use Addendum', () => {
        const text = sectionText(TERMS_OF_SERVICE, 'school-addendum');
        expect(text).toMatch(/School Use Addendum/);
        expect(text).toMatch(/order form/);
        expect(text).toMatch(/FERPA/);
        expect(text).toMatch(/30 days later/);
    });
});

describe('the copyright and content policy', () => {
    it('covers the DMCA notice, counter-notice and repeat-infringer rules, and the DSA contact point', () => {
        expect(sectionText(COPYRIGHT_POLICY, 'dmca-notice')).toMatch(/under penalty of perjury/);
        expect(sectionText(COPYRIGHT_POLICY, 'counter-notice')).toMatch(/10 to 14 business days/);
        expect(sectionText(COPYRIGHT_POLICY, 'repeat-infringers')).toMatch(/3 strikes within 12 months/);
        expect(sectionText(COPYRIGHT_POLICY, 'what-we-do')).toMatch(/statement of reasons/);
        expect(sectionText(COPYRIGHT_POLICY, 'contact-points')).toMatch(/single point of contact/);
        expect(COPYRIGHT_POLICY.action).toEqual({ label: 'Report content', to: '/report' });
    });
});

describe('LegalPage', () => {
    afterEach(cleanup);

    it('renders the privacy policy with its version, a contents list and mailto links', () => {
        render(
            <MemoryRouter>
                <PrivacyPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
        expect(screen.getByText(new RegExp(`Version ${LEGAL_VERSIONS.privacy}`))).toBeInTheDocument();
        expect(screen.getByRole('note')).toHaveTextContent(/awaiting final legal review/);
        const contents = screen.getByRole('navigation', { name: 'Contents' });
        expect(within(contents).getByRole('link', { name: 'How long we keep information' })).toHaveAttribute(
            'href',
            '#retention',
        );
        const mailto = screen.getAllByRole('link', { name: LEGAL_ENTITY.emails.privacy });
        expect(mailto[0]).toHaveAttribute('href', `mailto:${LEGAL_ENTITY.emails.privacy}`);
        expect(screen.getAllByText(/Placeholder — awaiting legal review:/).length).toBeGreaterThan(0);
    });

    it.each([
        [TermsPage, 'Terms of Service', 'Terms'],
        [RefundPolicyPage, 'Refund Policy', 'Refunds'],
        [CopyrightPolicyPage, 'Copyright and Content Policy', 'Copyright'],
    ])('renders %#: %s, linking to the other three policies', (Page, title, current) => {
        render(
            <MemoryRouter>
                <Page />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
        const nav = screen.getByRole('navigation', { name: 'Policies' });
        expect(within(nav).getByText(current)).toHaveAttribute('aria-current', 'page');
        const hrefs = within(nav)
            .getAllByRole('link')
            .map((link) => link.getAttribute('href'));
        expect(hrefs).toHaveLength(3);
        expect(new Set([...hrefs, `/${current === 'Refunds' ? 'refunds' : current.toLowerCase()}`])).toEqual(
            new Set(['/privacy', '/terms', '/refunds', '/copyright']),
        );
    });

    it('offers the report form from the copyright policy', () => {
        render(
            <MemoryRouter>
                <CopyrightPolicyPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('link', { name: 'Report content' })).toHaveAttribute('href', '/report');
    });
});
