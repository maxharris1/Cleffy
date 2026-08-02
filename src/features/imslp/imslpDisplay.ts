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
    const cleaned = withoutExt.replace(/^PMLP\d+-?/i, '').replace(/_/g, ' ').trim();
    return cleaned || filename;
};

/**
 * Pick a sensible default edition: prefer mid-size PDFs (often cleaner typesets)
 * over tiny stubs and huge multi-volume scans. Falls back to first edition.
 */
export const recommendEdition = <T extends { filename: string; size: number | null }>(
    editions: T[],
): T | null => {
    if (editions.length === 0) {
        return null;
    }
    const scored = editions.map((edition, index) => {
        const size = edition.size ?? 0;
        // Prefer 0.4–8 MB when size is known; penalize tiny and huge files.
        let score = 0;
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
    return scored[0]?.edition ?? editions[0] ?? null;
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
