import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { LEGAL_ENTITY, PRIVACY_POLICY, TERMS_OF_SERVICE, type LegalDocument } from '@/features/legal/legalContent';
import { PrivacyPage, TermsPage } from '@/features/legal/LegalPage';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { clearCloudAnnotationData } from '@/sync/signOutSync';
import type { Annotation } from '@/types/models';

const allText = (doc: LegalDocument): string =>
    doc.sections
        .flatMap((section) => [
            section.heading,
            ...section.blocks.flatMap((block) => (block.kind === 'list' ? block.items : [block.text])),
        ])
        .join('\n');

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
    it.each([
        ['privacy', PRIVACY_POLICY],
        ['terms', TERMS_OF_SERVICE],
    ])('%s has unique, linkable section ids and names a way to reach us', (_name, doc) => {
        const ids = doc.sections.map((section) => section.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect(id).toMatch(/^[a-z][a-z-]*$/);
        }
        expect(allText(doc)).toContain(LEGAL_ENTITY.contactEmail);
        expect(allText(doc)).not.toMatch(/TODO|TBD|lorem/i);
    });

    it('names every processor the code actually sends data to', () => {
        const text = allText(PRIVACY_POLICY);
        for (const processor of ['Supabase', 'Vercel', 'Stripe', 'Resend', 'Anthropic', 'Sentry']) {
            expect(text).toContain(processor);
        }
    });

    it('describes only the AI features this build ships', () => {
        // features.ts defaults every flag off, as the test build does.
        const text = allText(PRIVACY_POLICY);
        expect(text).toContain('Smart import');
        expect(text).not.toContain('Fingering suggestions');
        expect(text).not.toContain('Play-along');
        expect(text).not.toContain('Google Cloud');
    });

    it('does not claim a hosting region nobody has confirmed', () => {
        expect(LEGAL_ENTITY.dataRegion).toBeNull();
        expect(allText(PRIVACY_POLICY)).not.toMatch(/hosted on Amazon Web Services in /);
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
        const storage = PRIVACY_POLICY.sections.find((section) => section.id === 'device-storage');
        const text = storage ? allText({ ...PRIVACY_POLICY, sections: [storage] }) : '';
        expect(text).toMatch(/Signing out first uploads any markings and changes that have not finished syncing/);
        expect(text).toMatch(/tells you before going ahead, and if you sign out anyway they are lost/);
        expect(text).toMatch(/the device’s copy of your markings/);
        expect(text).toMatch(/Markings on files you opened from your device without uploading them stay/);
        expect(text).not.toMatch(/are kept, so no work is lost/);
    });

    it('explains what account deletion does, matching delete-account', () => {
        const deleting = PRIVACY_POLICY.sections.find((section) => section.id === 'deleting');
        const text = deleting ? allText({ ...PRIVACY_POLICY, sections: [deleting] }) : '';
        expect(text).toMatch(/subscription is cancelled/);
        expect(text).toMatch(/Student accounts you created are deleted/);
        expect(text).toMatch(/stay there, no longer attributed to you/);
        expect(text).toMatch(/cannot be undone/);
        // Guests delete themselves too (ShareDialog → delete-account's guest path).
        expect(text).toMatch(/delete that guest profile from the score’s Sharing panel/);
    });
});

describe('LegalPage', () => {
    afterEach(cleanup);

    it('renders the privacy policy with a contents list and mailto links', () => {
        render(
            <MemoryRouter>
                <PrivacyPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
        const contents = screen.getByRole('navigation', { name: 'Contents' });
        expect(within(contents).getByRole('link', { name: 'How long we keep information' })).toHaveAttribute(
            'href',
            '#retention',
        );
        const mailto = screen.getAllByRole('link', { name: LEGAL_ENTITY.contactEmail });
        expect(mailto.length).toBeGreaterThan(0);
        expect(mailto[0]).toHaveAttribute('href', `mailto:${LEGAL_ENTITY.contactEmail}`);
        expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    });

    it('renders the terms with a link back to the privacy policy', () => {
        render(
            <MemoryRouter>
                <TermsPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'Plans, billing and cancellation' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    });
});
