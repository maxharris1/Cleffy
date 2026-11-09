/** Presentation helpers for IMSLP titles and edition labels. */

import { SEARCH_TIMEOUT_COPY, WORK_NOT_FOUND_COPY } from '../../../supabase/functions/_shared/scoreSearchCopy';

export { SEARCH_TIMEOUT_COPY };

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
    filename: string;
    publisher?: string | null;
    description?: string | null;
    year?: number | null;
    arrangement?: boolean;
}

const isCompleteScore = (description: string): boolean => /^complete score\b/i.test(description.trim());

/**
 * How a musician names an edition: publisher and year. IMSLP file names
 * ("wier ihml 1", "joined document") are never the headline.
 */
export const editionHeadline = (edition: EditionDisplayFields): string => {
    const publisher = edition.publisher?.trim();
    if (publisher) {
        return [publisher, edition.year].filter(Boolean).join(', ');
    }
    return edition.year ? `Unknown publisher, ${edition.year}` : 'Unknown publisher';
};

/**
 * What the file holds when it is not the complete score: parts, one
 * movement, an arrangement. Null for a complete score, which needs no tag.
 */
export const editionScopeTag = (edition: EditionDisplayFields): string | null => {
    const description = edition.description?.trim() ?? '';
    if (description && !isCompleteScore(description) && !/^score$/i.test(description)) {
        return description;
    }
    return edition.arrangement ? 'Arrangement' : null;
};

/** The IMSLP file name without its PMLP prefix, underscores or extension. */
export const editionFileLabel = (filename: string): string => {
    const cleaned = filename
        .replace(/\.pdf$/i, '')
        .replace(/^PMLP\d+-?/i, '')
        .replace(/_/g, ' ')
        .trim();
    return cleaned || filename;
};

/**
 * Files whose headline and tag match another edition's, so only the file
 * name tells them apart. Everything else hides the file name.
 */
export const editionsNeedingFileLabel = (editions: EditionDisplayFields[]): Set<string> => {
    const key = (e: EditionDisplayFields) => `${editionHeadline(e)}\u0000${editionScopeTag(e) ?? ''}`;
    const counts = new Map<string, number>();
    for (const e of editions) {
        counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
    }
    return new Set(editions.filter((e) => (counts.get(key(e)) ?? 0) > 1).map((e) => e.filename));
};

/** True when the query has a letter or digit — `%%%` is not a search. */
export const hasSearchableQuery = (q: string): boolean => /[\p{L}\p{N}]/u.test(q);

/** Compatibility with older functions; source metadata and URLs never pass through here. */
export const genericScoreMessage = (message: string): string =>
    message
        .replace(/^Work not found on (?:IMSLP|the source page)\.?$/, WORK_NOT_FOUND_COPY)
        .replace(
            /(so it wasn't imported\. Try again in a minute) — or (?:open it on IMSLP|view the source page)\./g,
            '$1.',
        )
        .replace(/^IMSLP API timeout$/, 'The source page timed out')
        .replace(/^IMSLP API HTTP (\d+)$/, 'The source page returned HTTP $1')
        .replace(/^IMSLP API answer too large$/, 'The source page response is too large')
        .replace(/^IMSLP API\b/, 'The source page')
        .replace(/\bIMSLP work lookup failed\b/g, 'Could not load the source page')
        .replace(/\bIMSLP (search|download) failed\b/g, 'Score $1 failed')
        .replace(/^IMSLP (imports|downloads)\b/, 'Score $1')
        .replace(/\bIMSLP (imports|downloads)\b/g, 'score $1')
        .replace(/\bopen (?:it|the file) on IMSLP\b/g, 'view the source page')
        .replace(/\bon IMSLP\b/g, 'on the source page')
        .replace(/^IMSLP\b/, 'The source page')
        .replace(/\bIMSLP\b/g, 'the source page');

/** Map Postgres statement-timeout and abort timeouts to one friendly line. */
export const friendlySearchError = (err: unknown): string => {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
        return SEARCH_TIMEOUT_COPY;
    }
    const raw = err instanceof Error ? err.message : 'Search failed';
    if (/canceling statement|statement timeout|timed? out|took too long to answer/i.test(raw)) {
        return SEARCH_TIMEOUT_COPY;
    }
    return genericScoreMessage(raw);
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

/** IMSLP tagged the file `{{Urtext}}` — a filename hint alone never earns the badge. */
export const isTaggedUrtext = (edition: EditionRankFields): boolean => {
    const confidence = urtextConfidence(edition);
    return confidence === 'high' || confidence === 'medium';
};

/** One character folded for matching: accents off, lower case ("É" → "e"). */
const foldChar = (c: string): string => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{N}/u.test(c);

/**
 * Split a query into highlight tokens: its words (letters, digits and inner
 * apostrophes), deduplicated once folded. Short words stay — highlightRanges
 * decides how strictly each one must match.
 */
export const searchTokens = (query: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of query.split(/[^\p{L}\p{N}\p{M}'’]+/u)) {
        const token = raw.replace(/^['’]+|['’]+$/g, '');
        const key = [...token].map(foldChar).join('');
        if (key && /[\p{L}\p{N}]/u.test(key) && !seen.has(key)) {
            seen.add(key);
            out.push(token);
        }
    }
    return out;
};

/** Tokens this short only highlight as a whole word ("de", not the "De" of Debussy). */
const SHORT_TOKEN_MAX = 2;

export interface HighlightRange {
    start: number;
    end: number;
}

/**
 * Where to mark the query in a result line, as [start, end) offsets into
 * `text`. Matching is accent- and case-folded and starts only on a word
 * boundary (Unicode letters/digits; a letter–digit change counts, so "846"
 * marks in "BWV846"). A word of three or more letters may be a prefix
 * ("beeth" marks "Beeth|oven"); a one- or two-character token must be the
 * whole word, or "de" would light up "Claude", "Debussy" and "Préludes"; a
 * number is always whole (K.331 is not K.3310).
 */
export const highlightRanges = (text: string, tokens: string[]): HighlightRange[] => {
    // Fold per code point, remembering which original slice each folded
    // character came from, so a match maps back onto the unfolded text.
    let folded = '';
    const from: number[] = [];
    const to: number[] = [];
    let offset = 0;
    for (const ch of text) {
        const f = foldChar(ch);
        for (let k = 0; k < f.length; k++) {
            from.push(offset);
            to.push(offset + ch.length);
        }
        folded += f;
        offset += ch.length;
    }
    const needles = [...new Set(tokens.map((t) => [...t].map(foldChar).join('')).filter(Boolean))].sort(
        (a, b) => b.length - a.length,
    );
    if (needles.length === 0 || !folded) {
        return [];
    }
    const boundary = (i: number): boolean => {
        const before = folded[i - 1];
        const after = folded[i];
        if (!isWordChar(before) || !isWordChar(after)) {
            return true;
        }
        return isDigit(before) !== isDigit(after);
    };
    const ranges: HighlightRange[] = [];
    let p = 0;
    while (p < folded.length) {
        const needle = boundary(p)
            ? needles.find(
                  (n) =>
                      folded.startsWith(n, p) &&
                      (boundary(p + n.length) || (n.length > SHORT_TOKEN_MAX && !isDigit(n[n.length - 1]))),
              )
            : undefined;
        if (!needle) {
            p++;
            continue;
        }
        const start = from[p] ?? 0;
        let end = to[p + needle.length - 1] ?? text.length;
        // Keep a decomposed accent with its letter inside the same <mark>.
        while (end < text.length && /\p{M}/u.test(text[end] ?? '')) {
            end++;
        }
        const last = ranges[ranges.length - 1];
        if (last && last.end >= start) {
            last.end = Math.max(last.end, end);
        } else {
            ranges.push({ start, end });
        }
        p += needle.length;
    }
    return ranges;
};

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
