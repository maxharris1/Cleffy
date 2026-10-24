import type { LegalDocumentId } from '@/features/legal/legalVersions';

/**
 * The shape every legal document shares, and the helpers they are written
 * with. Each document is its own module (privacyPolicy.ts, termsOfService.ts,
 * refundPolicy.ts, copyrightPolicy.ts) and LegalPage.tsx only renders what is
 * there.
 */

/**
 * A sub-heading, a paragraph, a bulleted list, a fill-in form (the model
 * withdrawal form), or a placeholder: wording still with counsel, shown as a
 * marked callout so nobody mistakes it for final text. Email addresses render
 * as mailto links.
 */
export type LegalBlock =
    | { kind: 'h'; text: string }
    | { kind: 'p'; text: string }
    | { kind: 'list'; items: string[] }
    | { kind: 'form'; lines: string[] }
    | { kind: 'placeholder'; text: string };

export interface LegalSection {
    /** Stable anchor: /privacy#retention links survive copy edits. */
    id: string;
    heading: string;
    blocks: LegalBlock[];
}

export interface LegalDocument {
    id: LegalDocumentId;
    title: string;
    /** For the cross-links between documents: "Privacy", "Refunds". */
    shortTitle: string;
    summary: string;
    /** A button under the summary, for a document that is mostly about doing one thing. */
    action?: { label: string; to: string };
    sections: LegalSection[];
}

export const h = (text: string): LegalBlock => ({ kind: 'h', text });
export const p = (text: string): LegalBlock => ({ kind: 'p', text });
export const list = (...items: string[]): LegalBlock => ({ kind: 'list', items });
export const form = (...lines: string[]): LegalBlock => ({ kind: 'form', lines });
/** Wording counsel has not settled. Say what belongs here, not what it says. */
export const placeholder = (text: string): LegalBlock => ({ kind: 'placeholder', text });

/** Every string a reader sees, for tests that search a document's wording. */
export const legalText = (doc: Pick<LegalDocument, 'sections'>): string =>
    doc.sections
        .flatMap((section) => [
            section.heading,
            ...section.blocks.flatMap((block) =>
                block.kind === 'list' ? block.items : block.kind === 'form' ? block.lines : [block.text],
            ),
        ])
        .join('\n');
