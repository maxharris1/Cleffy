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
    source?: string;
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
    return URTEXT_NAME_HINT.test(`${edition.filename} ${edition.plate ?? ''} ${edition.publisher ?? ''}`)
        ? 'low'
        : 'none';
};

const URTEXT_BOOST: Record<UrtextConfidence, number> = { high: 1000, medium: 500, low: 15, none: 0 };

const ARRANGEMENT_HINT = /\b(arr|arrangement|arranged|transcription|parts?|incomplete|excerpts?)\b/i;

/** Enough to put a 2 MB arrangement below a 40 MB original, still above tiny stubs. */
const ARRANGEMENT_PENALTY = 80;

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

const isCompleteScore = (description: string): boolean => /^complete score\b/i.test(description.trim());

const isArrangement = (edition: EditionRankFields, description: string): boolean =>
    edition.arrangement === true || ARRANGEMENT_HINT.test(`${description} ${edition.filename}`);

const scoreEdition = (edition: EditionRankFields, index: number): number => {
    const confidence = urtextConfidence(edition);
    let score = sizeScore(edition.size ?? 0, index) + URTEXT_BOOST[confidence];
    const description = edition.description ?? '';
    if (isCompleteScore(description)) {
        score += 10;
    }
    // Below originals (including huge dumps) and above tiny stubs.
    if (isArrangement(edition, description)) {
        score -= ARRANGEMENT_PENALTY;
    }
    const house = urtextHouse(edition.publisher);
    if (!edition.urtext && !house && /complete|vollst|band|vol\.?\s*\d/i.test(edition.filename)) {
        score -= 5;
    }
    if (edition.source === 'catalog') {
        score += 200;
    }
    return score;
};

/**
 * Cleared for a one-tap fetch. `downloadable !== false` keeps older responses
 * without license fields eligible; `license === 'unknown'` is fail-open on the
 * server but must not be a one-tap import (the download 409s after insert).
 */
export const isEditionImportable = (edition: EditionLicenseFields): boolean =>
    edition.downloadable !== false && edition.license !== 'unknown';

/**
 * 0 = cleared for direct download, 1 = license unknown, 2 = restricted.
 * Used only among non-`{{Urtext}}` files so tagged Urtext still leads the list
 * when IMSLP has marked those rows not-downloadable.
 */
const availabilityTier = (edition: EditionLicenseFields): number => {
    if (edition.downloadable === false) {
        return 2;
    }
    return edition.license === 'unknown' ? 1 : 0;
};

const urtextLead = (edition: EditionRankFields): number => (edition.urtext ? 0 : 1);

/**
 * Full list in picker order: `{{Urtext}}` files first (including restricted
 * Henle), then downloadable non-Urtext, then license-unknown, then other
 * restricted rows. Score (house, complete original, size) breaks ties.
 */
export const rankEditions = <T extends EditionRankFields>(editions: T[]): T[] =>
    editions
        .map((edition, index) => ({
            edition,
            index,
            urtextLead: urtextLead(edition),
            tier: availabilityTier(edition),
            score: scoreEdition(edition, index),
        }))
        .sort(
            (a, b) =>
                a.urtextLead - b.urtextLead ||
                (a.urtextLead !== 0 ? a.tier - b.tier : 0) ||
                b.score - a.score ||
                a.index - b.index,
        )
        .map((r) => r.edition);

/**
 * Suggested import target: the top-ranked row, only when that row is actually
 * importable. Does not skip past a leading restricted Urtext to Weiner.
 */
export const recommendEdition = <T extends EditionRankFields>(editions: T[]): T | null => {
    const catalog = editions.find((edition) => edition.source === 'catalog' && isEditionImportable(edition));
    if (catalog) {
        return catalog;
    }
    const top = rankEditions(editions)[0];
    return top && isEditionImportable(top) ? top : null;
};

const VISIBLE_ROWS = 3;

/** Count line for the picker: never claims "Urtext first" when tagged files are last or absent. */
export const editionListSummary = (editions: EditionRankFields[], visibleRows = VISIBLE_ROWS): string | null => {
    const total = editions.length;
    if (total === 0) {
        return null;
    }
    if (total <= visibleRows) {
        return `${total} ${total === 1 ? 'PDF' : 'PDFs'}`;
    }
    const ranked = rankEditions(editions);
    const hasUrtext = editions.some((e) => e.urtext);
    const urtextInViewport = ranked.slice(0, visibleRows).some((e) => e.urtext);
    if (hasUrtext && urtextInViewport) {
        return `${total} PDFs · Urtext first — scroll for others.`;
    }
    return `${total} PDFs — scroll for others.`;
};

/** "Urtext · Henle · 1976" on every high-confidence hit; "Urtext · year" on other `{{Urtext}}`. */
export const urtextBadge = (edition: EditionRankFields): string | null => {
    const confidence = urtextConfidence(edition);
    switch (confidence) {
        case 'high':
            return ['Urtext', urtextHouse(edition.publisher), edition.year].filter(Boolean).join(' · ');
        case 'medium':
            return ['Urtext', edition.year].filter(Boolean).join(' · ');
        case 'low':
        case 'none':
            return null;
        default: {
            const _exhaustive: never = confidence;
            return _exhaustive;
        }
    }
};

/** Badge for a recommended (non-Urtext) row, or the Urtext badge when confidence is high/medium. */
export const recommendedBadge = (edition: EditionRankFields): string => urtextBadge(edition) ?? 'Recommended';

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
