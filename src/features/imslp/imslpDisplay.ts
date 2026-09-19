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

interface EditionRankFields extends EditionLicenseFields {
    filename: string;
    size: number | null;
    publisher?: string | null;
    year?: number | null;
    plate?: string | null;
    urtext?: boolean;
    arrangement?: boolean;
    description?: string | null;
}

/**
 * How sure we are that an edition is a scholarly Urtext:
 * - high: IMSLP's `{{Urtext}}` tag on a file from a modern Urtext house
 * - medium: `{{Urtext}}` from any other publisher (IMSLP's tag also covers
 *   plain re-engravings, so no house name is claimed)
 * - low: only the filename or plate looks like Henle/Bärenreiter/Urtext
 */
export type UrtextConfidence = 'high' | 'medium' | 'low' | 'none';

const URTEXT_HOUSES: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /henle/i, label: 'Henle' },
    { pattern: /b[aä]renreiter/i, label: 'Bärenreiter' },
    { pattern: /wiener urtext/i, label: 'Wiener Urtext' },
];

/** Short house label when the publisher is a recognized Urtext house. */
export const urtextHouse = (publisher: string | null | undefined): string | null =>
    publisher ? (URTEXT_HOUSES.find((h) => h.pattern.test(publisher))?.label ?? null) : null;

// Bare "wiener" is deliberately absent: Moonlight's `…moonlight.wiener.pdf`
// is Leo Weiner / Editio Musica Budapest, not Wiener Urtext.
const URTEXT_NAME_HINT = /henle|\bhn\s?\d|b[aä]renreiter|\bba\s?\d|urtext/i;

export const urtextConfidence = (edition: EditionRankFields): UrtextConfidence => {
    if (edition.urtext) {
        return urtextHouse(edition.publisher) ? 'high' : 'medium';
    }
    return URTEXT_NAME_HINT.test(`${edition.filename} ${edition.plate ?? ''}`) ? 'low' : 'none';
};

const URTEXT_BOOST: Record<UrtextConfidence, number> = { high: 1000, medium: 500, low: 15, none: 0 };

const ARRANGEMENT_HINT = /\b(arr|arrangement|arranged|transcription|parts?|incomplete|excerpts?)\b/i;

/** Prefer 0.4–8 MB when size is known; penalize tiny and huge files. */
const sizeScore = (size: number, index: number): number => {
    if (size <= 0) {
        return 10 - index * 0.01;
    }
    if (size >= 400_000 && size <= 8_000_000) {
        return 100 - Math.abs(size - 2_000_000) / 1_000_000;
    }
    return size < 400_000 ? 20 : 40;
};

const scoreEdition = (edition: EditionRankFields, index: number): number => {
    let score = sizeScore(edition.size ?? 0, index) + URTEXT_BOOST[urtextConfidence(edition)];
    const description = (edition.description ?? '').trim().toLowerCase();
    if (description === 'complete score') {
        score += 10;
    }
    // Below every mid-size original, above tiny stubs; IMSLP's Arranger field
    // catches arrangements whose description just says "Complete Score".
    if (edition.arrangement || ARRANGEMENT_HINT.test(`${description} ${edition.filename}`)) {
        score -= 50;
    }
    if (/complete|vollst|band|vol\.?\s*\d/i.test(edition.filename)) {
        score -= 5;
    }
    return score;
};

/**
 * 0 = cleared for direct download, 1 = license unknown (fail-open, never
 * recommended), 2 = restricted. `!== false` keeps editions without license
 * data (older responses, fixtures) eligible.
 */
const availabilityTier = (edition: EditionLicenseFields): number => {
    if (edition.downloadable === false) {
        return 2;
    }
    return edition.license === 'unknown' ? 1 : 0;
};

/**
 * Full list in picker order: downloadable editions first, Urtext-house files
 * ahead of other `{{Urtext}}` files ahead of everything else, size as the
 * tie-break, restricted rows last. IMSLP order breaks remaining ties.
 */
export const rankEditions = <T extends EditionRankFields>(editions: T[]): T[] =>
    editions
        .map((edition, index) => ({
            edition,
            index,
            tier: availabilityTier(edition),
            score: scoreEdition(edition, index),
        }))
        .sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index)
        .map((r) => r.edition);

/**
 * Default-highlighted edition: the top-ranked one that IMSLP lets us download
 * directly. Null when nothing qualifies — the panel then makes no selection.
 */
export const recommendEdition = <T extends EditionRankFields>(editions: T[]): T | null => {
    const top = rankEditions(editions)[0];
    return top && availabilityTier(top) === 0 ? top : null;
};

/** Badge for the recommended row: "Urtext · Henle · 1976" only on a high-confidence hit. */
export const recommendedBadge = (edition: EditionRankFields): string => {
    if (urtextConfidence(edition) !== 'high') {
        return 'Recommended';
    }
    return ['Urtext', urtextHouse(edition.publisher), edition.year].filter(Boolean).join(' · ');
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
