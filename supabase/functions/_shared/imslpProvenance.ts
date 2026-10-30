/**
 * The provenance imslp-download records on a document it imported
 * (documents.source_*; migration 20261007120700_document_provenance.sql).
 *
 * Every value is server-derived: the work title is the one the license check
 * verified the file against, the license label is IMSLP's own tag from the
 * license cache or a live parse, and the credits come from the work page's
 * file block. Nothing the browser sent is stored as-is.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it).
 */

export interface ImslpCredits {
    editor: string | null;
    arranger: string | null;
    publisher: string | null;
    year: number | null;
}

/** documents.source_attribution for an IMSLP import (mirrored in src/types/database.ts). */
export interface ImslpAttribution {
    source: 'imslp';
    /** The IMSLP work title, e.g. "Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)". */
    work: string;
    composer: string | null;
    editor: string | null;
    arranger: string | null;
    publisher: string | null;
    year: number | null;
}

export interface DocumentProvenance {
    source_url: string;
    source_filename: string;
    source_license: string | null;
    source_attribution: ImslpAttribution;
}

/** Matches workPageUrl in imslp.ts (kept import-free here). */
export const imslpWorkPageUrl = (title: string): string =>
    `https://imslp.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

/** "Work (Composer, Name)" → "Composer, Name" — IMSLP's title convention. */
export const composerFromWorkTitle = (title: string): string | null => {
    const match = title.match(/\(([^)]+)\)\s*$/);
    return match?.[1]?.trim() || null;
};

const clip = (value: string | null | undefined, max: number): string | null => {
    const trimmed = value?.replace(/\s+/g, ' ').trim() ?? '';
    if (!trimmed) {
        return null;
    }
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export const buildImslpProvenance = (input: {
    workTitle: string;
    filename: string;
    licenseLabel: string | null;
    credits: ImslpCredits | null;
}): DocumentProvenance => {
    const work = clip(input.workTitle, 300) ?? input.workTitle;
    const year = input.credits?.year;
    return {
        source_url: imslpWorkPageUrl(input.workTitle),
        source_filename: clip(input.filename, 512) ?? input.filename,
        source_license: clip(input.licenseLabel, 200),
        source_attribution: {
            source: 'imslp',
            work,
            composer: clip(composerFromWorkTitle(input.workTitle), 200),
            editor: clip(input.credits?.editor, 200),
            arranger: clip(input.credits?.arranger, 200),
            publisher: clip(input.credits?.publisher, 200),
            year: typeof year === 'number' && Number.isInteger(year) && year > 0 && year < 3000 ? year : null,
        },
    };
};
