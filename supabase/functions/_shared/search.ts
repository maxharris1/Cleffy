/**
 * Search helpers for IMSLP MediaWiki search (MW 1.18 — no CirrusSearch, no
 * fuzzy operators, title-only search by default).
 *
 * The edge function searches with `srwhat=text` (page bodies, MW-ranked — the
 * bodies are where nicknames live) and re-ranks ON TOP of MW's relevance order
 * via rankBonus instead of discarding it. Typo tolerance, accent folding and
 * opus/number normalization all happen here because the wiki can't.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it), so ranking changes are testable without an edge runtime.
 */

/** Non-decomposable letters NFD can't strip, plus musical accidentals. */
const CHAR_FOLDS: Record<string, string> = {
    ł: 'l',
    ø: 'o',
    đ: 'd',
    ð: 'd',
    þ: 'th',
    æ: 'ae',
    œ: 'oe',
    ß: 'ss',
    ı: 'i',
    '♭': '-flat',
    '♯': '-sharp',
    '♮': '',
};

export const foldAccents = (s: string): string =>
    s
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[łøđðþæœßı♭♯♮]/g, (c) => CHAR_FOLDS[c] ?? c);

export const foldEquals = (a: string, b: string): boolean => foldAccents(a) === foldAccents(b);

/**
 * Tokens too common in IMSLP titles to score on ("Op." and "No." appear in
 * nearly every title). Excluded from per-token scoring and the all-tokens
 * bonus, but left inside the phrase variants sent to MediaWiki.
 */
export const STOP_TOKENS: ReadonlySet<string> = new Set([
    'op',
    'no',
    'nr',
    'in',
    'the',
    'of',
    'for',
    'a',
    'an',
    'de',
    'la',
    'le',
    'und',
    'and',
    'von',
    'van',
    'der',
    'die',
    'das',
]);

/** Alternate transliterations → the spelling IMSLP uses. */
const COMPOSER_SPELLINGS: Array<[RegExp, string]> = [
    [/\b(?:rachmaninov|rakhmaninov|rachmaninow)\b/g, 'rachmaninoff'],
    [/\b(?:tschaikowsky|tchaikowsky|chaikovsky|czajkowski)\b/g, 'tchaikovsky'],
    [/\b(?:skryabin|skrjabin)\b/g, 'scriabin'],
    [/\b(?:prokofieff|prokofjew)\b/g, 'prokofiev'],
    [/\bhaendel\b/g, 'handel'],
    [/\bmoussorgsky\b/g, 'mussorgsky'],
    [/\bshostakovitch\b/g, 'shostakovich'],
    [/\bsaint saens\b/g, 'saint-saens'],
];

/**
 * Fold + canonicalize a query: "Opus 27 No 2" → "op.27 no.2", catalog numbers
 * ("BWV 565", "K 331") → dotted units, transliterations → IMSLP spellings.
 */
export const normalizeQuery = (q: string): string => {
    let s = foldAccents(q.trim().replace(/\s+/g, ' '));
    s = s.replace(/\b(?:op|opus)\s*\.?\s*(\d+[a-z]?)\b/g, 'op.$1');
    s = s.replace(/\b(?:no|nr|n[°º])\s*\.?\s*(\d+)\b/g, 'no.$1');
    s = s.replace(/\b(bwv|woo|hob|rv|kv)\s*\.?\s*(\d+)/g, '$1.$2');
    // Single-letter catalogs (K, D, S) only when clearly numeric (2+ digits).
    s = s.replace(/\b([kds])\s*\.?\s*(\d{2,})\b/g, '$1.$2');
    for (const [re, canonical] of COMPOSER_SPELLINGS) {
        s = s.replace(re, canonical);
    }
    return s;
};

/** Matches canonical "op.27" / "no.2" / "bwv.565"-style unit tokens. */
const UNIT_TOKEN_RE = /^(?:op|no|nr|bwv|woo|hob|rv|kv|k|d|s)\.\d+[a-z]?$/;

/**
 * Catalogs IMSLP writes with a space ("BWV 565", "WoO 59") — the only unit
 * tokens whose space form may match a title. "no 4" or "k 331" as substrings
 * would false-hit inside "piano 4 hands" or "polka 331".
 */
const SPACED_CATALOG_RE = /^(?:bwv|woo|hob|rv|kv)\.\d+[a-z]?$/;

/**
 * Normalized tokens with opus/number/catalog units kept atomic ("Op.27 No.2"
 * → ["op.27", "no.2"], never ["op", "27", "no"]).
 */
export const tokenizeQuery = (q: string): string[] =>
    normalizeQuery(q)
        .split(/[\s,/+|_]+/)
        .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((t) => t.length >= 2);

/** Optimal-string-alignment distance, capped at max+1 for early exit. */
export const damerauLevenshtein = (a: string, b: string, max = 2): number => {
    if (a === b) {
        return 0;
    }
    if (Math.abs(a.length - b.length) > max) {
        return max + 1;
    }
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) {
        return Math.max(m, n);
    }
    let prev2: number[] = [];
    let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur: number[] = new Array<number>(n + 1).fill(0);
        cur[0] = i;
        let rowMin = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min((prev[j] ?? max + 1) + 1, (cur[j - 1] ?? max + 1) + 1, (prev[j - 1] ?? max + 1) + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                v = Math.min(v, (prev2[j - 2] ?? max + 1) + 1);
            }
            cur[j] = v;
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) {
            return max + 1;
        }
        prev2 = prev;
        prev = cur;
    }
    return prev[n] ?? max + 1;
};

/** Length-tiered near-miss: dist ≤1 for 5–7 chars, ≤2 for 8+. Never for exact. */
export const nearMatch = (a: string, b: string): boolean => {
    if (a === b) {
        return false;
    }
    const len = Math.max(a.length, b.length);
    if (len < 5) {
        return false;
    }
    const max = len >= 8 ? 2 : 1;
    return damerauLevenshtein(a, b, max) <= max;
};

/**
 * Replace near-miss tokens with vocabulary words ("beethovn" → "beethoven").
 * Returns null when nothing changed, so callers only re-query on a real fix.
 */
export const correctTokens = (tokens: string[], vocab: Iterable<string>): string[] | null => {
    const words = [...new Set([...vocab].map(foldAccents))];
    let changed = false;
    const out = tokens.map((tok) => {
        const t = foldAccents(tok);
        if (t.length < 5 || !/^[a-z]+$/.test(t) || STOP_TOKENS.has(t) || words.includes(t)) {
            return tok;
        }
        const fix = words.find((w) => nearMatch(t, w));
        if (fix) {
            changed = true;
            return fix;
        }
        return tok;
    });
    return changed ? out : null;
};

/**
 * Real work pages end in a "(Surname, First)" parenthetical; text-mode search
 * also surfaces list/wishlist/publisher pages, which don't.
 */
export const isWorkTitle = (title: string): boolean => {
    if (/^(list of|wishlist)/i.test(title.trim())) {
        return false;
    }
    return /\([^()]*,[^()]*\)\s*$/.test(title);
};

export const scoreTitleMatch = (title: string, tokens: string[]): number => {
    if (tokens.length === 0) {
        return 0;
    }
    const foldedTitle = foldAccents(title);
    const composerMatch = title.match(/\(([^)]+)\)\s*$/);
    const foldedComposer = composerMatch ? foldAccents(composerMatch[1] ?? '') : '';
    const titleWords = foldedTitle.split(/[\s,()/]+/).filter((w) => w.length >= 4);

    const scorable = tokens.map(foldAccents).filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
    let score = 0;
    let hits = 0;
    for (const t of scorable) {
        if (UNIT_TOKEN_RE.test(t)) {
            // "op.27" matching the title is a much stronger signal than a word.
            if (foldedTitle.includes(t) || (SPACED_CATALOG_RE.test(t) && foldedTitle.includes(t.replace('.', ' ')))) {
                score += 6;
                hits += 1;
            }
            continue;
        }
        if (foldedTitle.includes(t)) {
            score += 3;
            hits += 1;
        } else if (t.length >= 5 && titleWords.some((w) => nearMatch(t, w))) {
            score += 2;
            hits += 1;
        }
        if (foldedComposer.includes(t)) {
            score += 4;
        }
    }
    // Bonus when every meaningful token hits somewhere in the title.
    if (hits === scorable.length && scorable.length > 1) {
        score += 8;
    }
    return score;
};

export interface AliasEntry {
    keys: string[];
    title: string;
}

/** Every alias whose key appears (folded) inside the query. */
export const aliasTitlesForQuery = (q: string, aliases: AliasEntry[]): string[] => {
    const foldedQ = foldAccents(normalizeQuery(q));
    if (!foldedQ) {
        return [];
    }
    const titles: string[] = [];
    for (const alias of aliases) {
        if (alias.keys.some((k) => foldedQ.includes(foldAccents(k)))) {
            titles.push(alias.title);
        }
    }
    return titles;
};

export interface SearchVariant {
    q: string;
    /** Scales the MW rank bonus — how much we trust this variant's ordering. */
    weight: number;
}

/**
 * MediaWiki search strings for one query, most-trusted first, capped at 6.
 * With srwhat=text the full query does the heavy lifting; the rest are rescue
 * variants (alias canonical titles, facet-scoped, bigrams, lone tokens).
 */
export const buildSearchVariants = (
    q: string,
    opts: { aliasTitles?: string[]; facetTokens?: string[] } = {},
): SearchVariant[] => {
    const trimmed = q.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
        return [];
    }
    const normalized = normalizeQuery(trimmed);
    const meaningful = tokenizeQuery(trimmed).filter((t) => !STOP_TOKENS.has(t));

    const out: SearchVariant[] = [];
    const seen = new Set<string>();
    const push = (variant: string, weight: number) => {
        const key = foldAccents(variant);
        if (!key || seen.has(key) || out.length >= 6) {
            return;
        }
        seen.add(key);
        out.push({ q: variant, weight });
    };

    push(trimmed, 1);
    push(normalized, 1);
    for (const title of (opts.aliasTitles ?? []).slice(0, 2)) {
        push(title, 1);
    }
    const facetTok = (opts.facetTokens ?? [])[0];
    if (facetTok && facetTok.length >= 2) {
        push(`${facetTok} ${trimmed}`, 0.8);
    }
    if (meaningful.length >= 3) {
        push(meaningful.slice(0, 2).join(' '), 0.6);
        push(meaningful.slice(-2).join(' '), 0.6);
    }
    if (meaningful.length === 2) {
        // Lone-token rescue for 2-token queries (one may be a broken nickname).
        for (const tok of meaningful) {
            if (tok.length >= 4 && !/^\d+$/.test(tok) && !UNIT_TOKEN_RE.test(tok)) {
                push(tok, 0.3);
            }
        }
    }
    return out;
};

/** MW rank position → score bonus, scaled by variant trust. */
export const rankBonus = (position: number, weight: number): number => weight * 24 * 0.85 ** position;

export interface RankHitInput {
    title: string;
    pageid: number;
    snippet?: string;
    timestamp?: string;
}

export interface RankBatch {
    variant: SearchVariant;
    hits: RankHitInput[];
}

export interface RankedHit {
    title: string;
    pageid: number;
    snippet: string;
    timestamp: string | null;
    score: number;
}

export interface RankOptions {
    query: string;
    tokens: string[];
    aliasTitles?: string[];
    /** Folded titles of curated famous works (+12 prior). */
    popularTitles?: Set<string>;
    resolvedTitles?: Map<string, string>;
    resolvedPageIds?: Map<string, number>;
    /** Folded resolved title → hard-filter categories the page belongs to. */
    categoryHits?: Map<string, Set<string>>;
    /** When true, drop hits with no categoryHits entry (instrument hard filter). */
    requireCategories?: boolean;
    /**
     * Folded titles whose category lookup never completed. Under
     * requireCategories they mean "unknown", not "not a member" — an upstream
     * failure must not be indistinguishable from a genuine non-match.
     */
    unverifiedTitles?: Set<string>;
    /** Facet boosts etc., supplied by the caller so this stays data-free. */
    extraScore?: (title: string) => number;
}

/**
 * Merge per-variant MW batches into one ranked list: best rank bonus across
 * variants + token/alias/popularity/facet scoring, junk pages dropped.
 */
export const mergeAndRank = (batches: RankBatch[], opts: RankOptions): RankedHit[] => {
    const aliasSet = new Set(opts.aliasTitles ?? []);
    const merged = new Map<string, RankedHit>();

    for (const batch of batches) {
        batch.hits.forEach((hit, position) => {
            const title = opts.resolvedTitles?.get(hit.title) ?? hit.title;
            if (!isWorkTitle(title)) {
                return;
            }
            const bonus = rankBonus(position, batch.variant.weight);
            const pageid = opts.resolvedPageIds?.get(title) ?? hit.pageid;
            const existing = merged.get(title);
            if (existing) {
                existing.score = Math.max(existing.score, bonus);
                if (!existing.snippet && hit.snippet) {
                    existing.snippet = hit.snippet.replace(/<[^>]+>/g, '');
                }
                if (!existing.timestamp && hit.timestamp) {
                    existing.timestamp = hit.timestamp;
                }
                if (existing.pageid === 0 && pageid > 0) {
                    existing.pageid = pageid;
                }
            } else {
                merged.set(title, {
                    title,
                    pageid,
                    snippet: (hit.snippet ?? '').replace(/<[^>]+>/g, ''),
                    timestamp: hit.timestamp ?? null,
                    score: bonus,
                });
            }
        });
    }

    const ranked: RankedHit[] = [];
    for (const hit of merged.values()) {
        const folded = foldAccents(hit.title);
        const categories = opts.categoryHits?.get(folded);
        if (opts.requireCategories && !opts.unverifiedTitles?.has(folded) && (!categories || categories.size === 0)) {
            continue;
        }
        let score = hit.score + scoreTitleMatch(hit.title, opts.tokens);
        if (aliasSet.has(hit.title)) {
            score += 50;
        }
        if (opts.popularTitles?.has(folded)) {
            score += 12;
        }
        if (foldEquals(hit.title, opts.query)) {
            score += 5;
        }
        if (categories && [...categories].some((c) => !/\(arr\)$/i.test(c))) {
            // Original "For X" membership outranks "(arr)" arrangements.
            score += 6;
        }
        if (opts.extraScore) {
            score += opts.extraScore(hit.title);
        }
        ranked.push({ ...hit, score });
    }

    ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return ranked;
};
