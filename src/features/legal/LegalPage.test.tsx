import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { LEGAL_ENTITY, PRIVACY_POLICY, TERMS_OF_SERVICE, type LegalDocument } from '@/features/legal/legalContent';
import { PrivacyPage, TermsPage } from '@/features/legal/LegalPage';

const allText = (doc: LegalDocument): string =>
    doc.sections
        .flatMap((section) => [
            section.heading,
            ...section.blocks.flatMap((block) => (block.kind === 'list' ? block.items : [block.text])),
        ])
        .join('\n');

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

    it('explains what account deletion does, matching delete-account', () => {
        const deleting = PRIVACY_POLICY.sections.find((section) => section.id === 'deleting');
        const text = deleting ? allText({ ...PRIVACY_POLICY, sections: [deleting] }) : '';
        expect(text).toMatch(/subscription is cancelled/);
        expect(text).toMatch(/Student accounts you created are deleted/);
        expect(text).toMatch(/stay there, no longer attributed to you/);
        expect(text).toMatch(/cannot be undone/);
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
