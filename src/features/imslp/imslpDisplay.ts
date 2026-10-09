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

export interface EditionDisplayFields {
    publisher?: string | null;
    description?: string | null;
    year?: number | null;
}

/** Generic IMSLP file-block descriptions — not a human edition name. */
const GENERIC_FILE_DESCRIPTION = /^(complete score|score|parts?|piano reduction|vocal score)\b/i;

const fromFilename = (filename: string): string => {
    const withoutExt = filename.replace(/\.pdf$/i, '');
    const cleaned = withoutExt
        .replace(/^PMLP\d+-?/i, '')
        .replace(/_/g, ' ')
        .trim();
    return cleaned || filename;
};

/** Dump slugs: WIMA ids, catalog stubs like Btsn312, or a few leftover characters. */
const looksLikeDumpName = (name: string): boolean => {
    const trimmed = name.trim();
    if (!trimmed) {
        return true;
    }
    if (/^WIMA\b/i.test(trimmed)) {
        return true;
    }
    const compact = trimmed.replace(/[\s._-]+/g, '');
    if (compact.length < 8) {
        return true;
    }
    return /^[A-Za-z]{1,8}\d{2,}$/.test(compact);
};

/**
 * Drop noisy PMLP prefixes from edition filenames. When the leftover still
 * looks like a dump slug, prefer publisher / a non-generic description.
 */
export const displayEditionName = (filename: string, meta?: EditionDisplayFields): string => {
    const fromFile = fromFilename(filename);
    if (!looksLikeDumpName(fromFile)) {
        return fromFile;
    }
    const description = meta?.description?.trim() ?? '';
    if (description && !GENERIC_FILE_DESCRIPTION.test(description) && !looksLikeDumpName(description)) {
        return description;
    }
    const publisher = meta?.publisher?.trim() ?? '';
    if (publisher) {
        return [publisher, meta?.year].filter(Boolean).join(' ');
    }
    return fromFile;
};

/** True when the query has a letter or digit — `%%%` is not a search. */
export const hasSearchableQuery = (q: string): boolean => /[\p{L}\p{N}]/u.test(q);

export const SEARCH_TIMEOUT_COPY = 'IMSLP took too long to answer.';

/** Map Postgres statement-timeout and abort timeouts to one friendly line. */
export const friendlySearchError = (err: unknown): string => {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
        return SEARCH_TIMEOUT_COPY;
    }
    const raw = err instanceof Error ? err.message : 'Search failed';
    if (/canceling statement|statement timeout|timed? out/i.test(raw)) {
        return SEARCH_TIMEOUT_COPY;
    }
    return raw;
};

interface EditionLicenseFields {
    license?: string;
    licenseLabel?: string | null;
    restriction?: string | null;
    downloadable?: boolean;
    licenseCheck?: 'unavailable';
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
        // IMSLP could not be asked just now: say so, rather than implying the
        // file failed a check it never had.
        if (edition.licenseCheck === 'unavailable') {
            return { kind: 'unknown', label: 'License check unavailable' };
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
    return score;
};

/**
 * Cleared for a one-tap fetch. `downloadable !== false` keeps older responses
 * without license fields eligible; `license === 'unknown'` is never importable
 * (imslp-download refuses it as license_unknown, and older imslp-work builds
 * still marked a failed lookup downloadable).
 */
export const isEditionImportable = (edition: EditionLicenseFields): boolean =>
    edition.downloadable !== false && edition.license !== 'unknown';

/** 0 = license unknown (IMSLP may clear it), 1 = restricted. Orders the rows Cleffy cannot fetch. */
const unavailableTier = (edition: EditionLicenseFields): number => (edition.downloadable === false ? 1 : 0);

const urtextLead = (edition: EditionRankFields): number => (edition.urtext ? 0 : 1);

/**
 * Full list in picker order: everything Cleffy can import first — `{{Urtext}}`
 * files leading, then by score (house, complete original, size) — and only
 * then the rows it cannot fetch (Urtext first, license-unknown before
 * restricted). A restricted Henle used to lead the list, so popular works
 * (Moonlight, Pathétique) opened on greyed-out rows with nothing selected.
 */
export const rankEditions = <T extends EditionRankFields>(editions: T[]): T[] =>
    editions
        .map((edition, index) => ({
            edition,
            index,
            blocked: isEditionImportable(edition) ? 0 : 1,
            urtextLead: urtextLead(edition),
            tier: unavailableTier(edition),
            score: scoreEdition(edition, index),
        }))
        .sort(
            (a, b) =>
                a.blocked - b.blocked ||
                a.urtextLead - b.urtextLead ||
                a.tier - b.tier ||
                b.score - a.score ||
                a.index - b.index,
        )
        .map((r) => r.edition);

/**
 * The picker's two lists, each in rankEditions order: what Add can import, and
 * what the user can only open on IMSLP (restricted or license-unknown).
 */
export const splitEditions = <T extends EditionRankFields>(editions: T[]): { importable: T[]; unavailable: T[] } => {
    const ranked = rankEditions(editions);
    return {
        importable: ranked.filter((e) => isEditionImportable(e)),
        unavailable: ranked.filter((e) => !isEditionImportable(e)),
    };
};

/**
 * Pre-selected import target: the best edition Cleffy can actually fetch, so
 * Add works on the first screen. A restricted Urtext does not block it; it
 * stays listed (with its IMSLP link) under the importable ones.
 */
export const recommendEdition = <T extends EditionRankFields>(editions: T[]): T | null =>
    splitEditions(editions).importable[0] ?? null;

const VISIBLE_ROWS = 3;

/**
 * Count line for the importable list: never claims "Urtext first" when tagged
 * files are last or absent, and says "downloadable" when some files are listed
 * separately as not.
 */
export const editionListSummary = (editions: EditionRankFields[], visibleRows = VISIBLE_ROWS): string | null => {
    const { importable, unavailable } = splitEditions(editions);
    const total = importable.length;
    if (total === 0) {
        return null;
    }
    const noun = `${unavailable.length > 0 ? 'downloadable ' : ''}${total === 1 ? 'PDF' : 'PDFs'}`;
    if (total <= visibleRows) {
        return `${total} ${noun}`;
    }
    if (importable.slice(0, visibleRows).some((e) => e.urtext)) {
        return `${total} ${noun} · Urtext first — scroll for others.`;
    }
    return `${total} ${noun} — scroll for others.`;
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
