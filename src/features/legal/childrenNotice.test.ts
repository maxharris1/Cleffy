import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHILDREN_NOTICE } from '@/features/legal/childrenNotice';
import { LEGAL_DOCUMENTS, legalText, type LegalDocument } from '@/features/legal/legalContent';
import { LEGAL_DOCUMENT_IDS } from '@/features/legal/legalVersions';
import type * as FeaturesModule from '@/lib/features';

/**
 * Cleffy must never claim COPPA compliance or certification, on any page or in
 * the internal drafts counsel reads. The notice and policies are drafts that
 * counsel has not signed off (docs/LEGAL_REVIEW.md §23).
 */
const COPPA_CLAIM = /COPPA[- ]?(compliant|certified)|compl(iant|y|ies) with COPPA/i;

const ROOT = process.cwd();

/** The internal drafts that must not read as a statement of compliance either. */
const INTERNAL_DRAFTS = ['docs/CHILDREN_DATA_RETENTION.md', 'docs/INFORMATION_SECURITY_PROGRAM.md'];

/** Every reader-visible string of a document, title and summary included. */
const fullText = (doc: LegalDocument): string => [doc.title, doc.shortTitle, doc.summary, legalText(doc)].join('\n');

/** Every app source file a page can be built from — not the tests, which spell the claim out to search for it. */
const appSources = (): string[] =>
    readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.(ts|tsx|html|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
        .map((file) => join(ROOT, 'src', file))
        .concat(join(ROOT, 'index.html'));

/** The legal documents as a build with VITE_FEATURE_VIEW_LINKS=1 would publish them. */
const documentsWithViewLinks = async () => {
    vi.resetModules();
    vi.doMock('@/lib/features', async (importOriginal) => {
        const actual = await importOriginal<typeof FeaturesModule>();
        return { features: { ...actual.features, viewLinks: true } };
    });
    const content = await import('@/features/legal/legalContent');
    return content.LEGAL_DOCUMENTS;
};

afterEach(() => {
    vi.doUnmock('@/lib/features');
    vi.resetModules();
});

describe('the children’s privacy notice', () => {
    it('is visibly a draft', () => {
        expect(legalText(CHILDREN_NOTICE)).toContain('DRAFT');
        expect(CHILDREN_NOTICE.sections[0]?.blocks[0]).toEqual({
            kind: 'placeholder',
            text: 'DRAFT — awaiting legal review. Not in effect.',
        });
    });

    it('carries the phone-number placeholder', () => {
        const whoWeAre = CHILDREN_NOTICE.sections.find((section) => section.id === 'who-we-are');
        expect(whoWeAre?.blocks).toContainEqual({ kind: 'placeholder', text: 'Phone number — Max to supply' });
    });

    it('leaves out view links while they are switched off', () => {
        expect(CHILDREN_NOTICE.sections.map((section) => section.id)).not.toContain('view-links');
        expect(fullText(CHILDREN_NOTICE)).not.toMatch(/view link/i);
    });

    it('describes view links, as a draft, once they are switched on', async () => {
        const docs = await documentsWithViewLinks();
        const section = docs.children.sections.find((candidate) => candidate.id === 'view-links');
        expect(section).toBeDefined();
        const text = legalText({ sections: section ? [section] : [] });
        expect(text).toMatch(/stores nothing about the viewer/);
        expect(text).toMatch(/never used to contact anyone/);
        // The large-PDF fallback (over 4 MB): the one time the device talks to Supabase.
        expect(text).toMatch(/directly from our storage provider through a link that works for one minute/);
        expect(section?.blocks).toContainEqual({
            kind: 'placeholder',
            text: 'Counsel: retention wording (Vercel runtime logs 1 h; …)',
        });
        expect(legalText(docs.terms)).toMatch(/own screen or share a view link, when available\./);
    });
});

describe('no COPPA compliance claim', () => {
    it('makes sure the pattern catches the claims it is meant to', () => {
        for (const claim of [
            'COPPA compliant',
            'COPPA-compliant',
            'coppa certified',
            'fully compliant with COPPA',
            'Cleffy complies with COPPA',
            'we comply with COPPA',
        ]) {
            expect(claim).toMatch(COPPA_CLAIM);
        }
        expect('not a statement of compliance').not.toMatch(COPPA_CLAIM);
    });

    it('appears in no legal document, with view links off', () => {
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(fullText(LEGAL_DOCUMENTS[id]), id).not.toMatch(COPPA_CLAIM);
        }
    });

    it('appears in no legal document, with view links on', async () => {
        const docs = await documentsWithViewLinks();
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(fullText(docs[id]), id).not.toMatch(COPPA_CLAIM);
        }
    });

    it('appears in neither internal draft, and each says it is not a statement of compliance', () => {
        for (const file of INTERNAL_DRAFTS) {
            const text = readFileSync(join(ROOT, file), 'utf8');
            expect(text, file).not.toMatch(COPPA_CLAIM);
            expect(text.split('\n')[0], file).toBe('DRAFT — not reviewed by counsel; not a statement of compliance.');
        }
    });

    it('appears in no app source file', () => {
        const files = appSources();
        expect(files.length).toBeGreaterThan(50);
        for (const file of files) {
            expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toMatch(COPPA_CLAIM);
        }
    });
});
