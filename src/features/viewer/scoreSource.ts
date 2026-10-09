import type { DocumentRow } from '@/types/database';

/** The provenance columns a document row may carry (absent on list rows). */
export type ProvenanceFields = Pick<
    DocumentRow,
    'source_url' | 'source_filename' | 'source_license' | 'source_attribution'
>;

/** True when the score carries recorded provenance worth showing. */
export const hasScoreSource = (doc: ProvenanceFields): boolean => Boolean(doc.source_url || doc.source_license);

/** Creative Commons licenses other than CC0 oblige a copy to carry its credit. */
export const requiresAttribution = (license: string | null | undefined): boolean => {
    const folded = license?.trim().toLowerCase() ?? '';
    return folded.startsWith('creative commons') && !/\bzero\b|\bcc0\b/.test(folded);
};

/**
 * IMSLP's page for one uploaded file (its license, uploader and history), the
 * File: namespace page for the recorded filename. Spaces become underscores
 * the way MediaWiki writes titles; everything else is percent-encoded, so a
 * filename can never turn into another path or origin.
 */
export const imslpFilePageUrl = (filename: string | null | undefined): string | null => {
    const name = filename?.trim();
    if (!name) {
        return null;
    }
    return `https://imslp.org/wiki/File:${encodeURIComponent(name.replace(/ /g, '_'))}`;
};
