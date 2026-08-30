/** Presentation helpers for IMSLP titles and edition labels. */

export const formatBytes = (size: number | null): string => {
    if (size === null || size <= 0) {
        return '';
    }
    if (size < 1024) {
        return `${size} B`;
    }
    if (size < 1024 * 1024) {
        return `${(size / 1024).toFixed(0)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export const suggestedPdfName = (workTitle: string, filename: string): string => {
    const base = workTitle.replace(/[\\/:*?"<>|]/g, '').trim() || filename.replace(/\.pdf$/i, '');
    return `${base}.pdf`;
};

/** Split IMSLP "Work (Composer, Name)" titles for clearer list rows. */
export const displayWorkTitle = (title: string): { work: string; composer: string | null } => {
    const match = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!match) {
        return { work: title, composer: null };
    }
    return { work: match[1]?.trim() || title, composer: match[2]?.trim() || null };
};

/** Drop noisy PMLP prefixes from edition filenames for the picker. */
export const displayEditionName = (filename: string): string => {
    const withoutExt = filename.replace(/\.pdf$/i, '');
    const cleaned = withoutExt
        .replace(/^PMLP\d+-?/i, '')
        .replace(/_/g, ' ')
        .trim();
    return cleaned || filename;
};

interface EditionLicenseFields {
    license?: string;
    licenseLabel?: string | null;
    restriction?: string | null;
    downloadable?: boolean;
}

export type EditionAvailability =
    | { kind: 'downloadable'; label: string }
    | { kind: 'restricted'; label: string }
    | { kind: 'unknown'; label: string };

/** Short availability status for an edition row; null for pre-license data. */
export const editionAvailability = (edition: EditionLicenseFields): EditionAvailability | null => {
    if (edition.downloadable === undefined && edition.license === undefined) {
        return null;
    }
    if (edition.downloadable === false) {
        // Claim a restriction only where IMSLP stated one (a red regional flag,
        // or a Non-PD license tag). Everything else that merely failed the
        // downloadable check — EU-mirror hosting, an unparsed Copyright cell —
        // is unverified, not restricted.
        if (edition.restriction) {
            return { kind: 'restricted', label: edition.restriction };
        }
        if (edition.license === 'non-pd') {
            return { kind: 'restricted', label: edition.licenseLabel ?? 'Copyright restricted' };
        }
        return { kind: 'unknown', label: 'License unverified' };
    }
    if (edition.license === 'pd') {
        return { kind: 'downloadable', label: 'Public domain' };
    }
    if (edition.license === 'cc') {
        return { kind: 'downloadable', label: edition.licenseLabel ?? 'CC licensed' };
    }
    return { kind: 'unknown', label: 'License unknown' };
};

/**
 * Pick a sensible default edition: only ones IMSLP lets us download directly
 * (never a restricted or license-unknown file), preferring mid-size PDFs
 * (often cleaner typesets) over tiny stubs and huge multi-volume scans.
 * Null when nothing qualifies — the panel then makes no auto-selection.
 */
export const recommendEdition = <T extends { filename: string; size: number | null } & EditionLicenseFields>(
    editions: T[],
): T | null => {
    // `!== false` keeps editions without license data (older responses,
    // fixtures) eligible; 'unknown' means the page was checked and this file
    // wasn't cleared, which is not something to recommend.
    const candidates = editions.filter((e) => e.downloadable !== false && e.license !== 'unknown');
    if (candidates.length === 0) {
        return null;
    }
    const scored = candidates.map((edition, index) => {
        const size = edition.size ?? 0;
        // Prefer 0.4–8 MB when size is known; penalize tiny and huge files.
        let score: number;
        if (size <= 0) {
            score = 10 - index * 0.01;
        } else if (size >= 400_000 && size <= 8_000_000) {
            score = 100 - Math.abs(size - 2_000_000) / 1_000_000;
        } else if (size < 400_000) {
            score = 20;
        } else {
            score = 40;
        }
        const name = edition.filename.toLowerCase();
        if (/urtext|henle|breitkopf|schirmer|typeset|edited/i.test(name)) {
            score += 8;
        }
        if (/complete|vollst|band|vol\.?\s*\d/i.test(name)) {
            score -= 5;
        }
        return { edition, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.edition ?? null;
};

/** Split query into highlight tokens (≥2 chars). */
export const searchTokens = (query: string): string[] =>
    query
        .trim()
        .split(/[\s,./+\-_|]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);

const BEST_MATCH_COUNT = 8;

/** Split ranked results into Best matches vs More (search is already score-sorted). */
export const splitSearchResults = <T>(results: T[]): { best: T[]; more: T[] } => {
    if (results.length <= BEST_MATCH_COUNT) {
        return { best: results, more: [] };
    }
    return {
        best: results.slice(0, BEST_MATCH_COUNT),
        more: results.slice(BEST_MATCH_COUNT),
    };
};
