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

export type PeriodEraId = 'baroque' | 'classical' | 'romantic' | 'early-20th' | 'modern';

const YEAR_MIN = 1500;
const YEAR_MAX = 2026;

const erasForYear = (year: number): PeriodEraId[] => {
    if (year < YEAR_MIN || year > YEAR_MAX) {
        return [];
    }
    if (year >= 1600 && year <= 1749) {
        return ['baroque'];
    }
    if (year >= 1750 && year <= 1819) {
        return ['classical'];
    }
    if (year >= 1820 && year <= 1899) {
        return ['romantic'];
    }
    if (year >= 1900 && year <= 1945) {
        return ['early-20th'];
    }
    if (year >= 1946) {
        return ['modern'];
    }
    return [];
};

const erasForRange = (from: number, to: number): PeriodEraId[] => {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const out: PeriodEraId[] = [];
    const seen = new Set<PeriodEraId>();
    const samples = [start, end, 1600, 1750, 1820, 1900, 1946];
    for (const year of samples) {
        if (year < start || year > end) {
            continue;
        }
        for (const era of erasForYear(year)) {
            if (!seen.has(era)) {
                seen.add(era);
                out.push(era);
            }
        }
    }
    return out;
};

const pushUnique = (into: PeriodEraId[], eras: PeriodEraId[]) => {
    for (const era of eras) {
        if (!into.includes(era)) {
            into.push(era);
        }
    }
};

/**
 * Pull period words and years out of a typed query. Tokens are removed from
 * `rest` so they do not have to appear in the title. `classical` is not a
 * period when followed by `guitar`.
 */
export const extractPeriod = (q: string): { eraIds: PeriodEraId[]; rest: string } => {
    const eraIds: PeriodEraId[] = [];
    let rest = q.trim().replace(/\s+/g, ' ');
    if (!rest) {
        return { eraIds, rest: '' };
    }

    const strip = (re: RegExp, eras: PeriodEraId[] | ((match: RegExpExecArray) => PeriodEraId[])) => {
        const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        rest = rest.replace(global, (substring, ...args) => {
            const match = [substring, ...args.slice(0, -2)] as unknown as RegExpExecArray;
            match[0] = substring;
            const ids = typeof eras === 'function' ? eras(match) : eras;
            pushUnique(eraIds, ids);
            return ' ';
        });
    };

    // Guard first so "classical guitar" is not eaten as a period.
    rest = rest.replace(/\bclassical\s+guitar\b/gi, '§cg§');

    strip(/\bearly\s+20th(?:\s+century)?\b/i, ['early-20th']);
    strip(/\b20th\s+century\b/i, ['early-20th', 'modern']);
    strip(/\b(?:contemporary|modern)\b/i, ['modern']);
    strip(/\bbaroque\b/i, ['baroque']);
    strip(/\bromantic\b/i, ['romantic']);
    strip(/\bclassical\b/i, ['classical']);
    strip(/\b(\d{1,2})(?:st|nd|rd|th)\s+century\b/i, (m) => {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n < 16 || n > 21) {
            return [];
        }
        const start = (n - 1) * 100 + 1;
        const end = n * 100;
        return erasForRange(start, end);
    });
    strip(/\b(1[5-9]\d{2}|20[0-2]\d)s\b/i, (m) => {
        const start = Number(m[1]);
        return erasForRange(start, start + 9);
    });
    strip(/\b(1[5-9]\d{2}|20[0-2]\d)\s*[-–—]\s*(1[5-9]\d{2}|20[0-2]\d)\b/, (m) => {
        return erasForRange(Number(m[1]), Number(m[2]));
    });
    strip(/\b(1[5-9]\d{2}|20[0-2]\d)\b/, (m) => erasForYear(Number(m[1])));

    rest = rest.replace(/§cg§/gi, 'classical guitar');
    rest = rest.replace(/\s+/g, ' ').trim();
    return { eraIds, rest };
};

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

/** Work-page fields whose values read as prose; every other `|Field=` line is file plumbing. */
const SNIPPET_FIELDS = new Set(
    [
        'work title',
        'alternative title',
        'opus/catalogue number',
        'movements/sections',
        'year/date of composition',
        'first performance',
        'dedication',
        'instrumentation',
        'piece style',
        'comments',
        'notes',
        'misc. notes',
        'discography',
    ].map((f) => f.toLowerCase()),
);

const MEDIA_FILE_RE = /\.(?:pdf|mp3|ogg|flac|mid|midi|png|jpe?g|gif|zip|mxl|musicxml|sib|mus)\b/i;
const SNIPPET_MAX = 200;

const decodeEntities = (s: string): string =>
    s
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');

/** `{{plain|url|label}}` → label, `{{K|Ab}}` → Ab, `{{cite}}` → nothing. */
const stripTemplates = (s: string): string => {
    let out = s;
    for (let i = 0; i < 4 && out.includes('{{'); i++) {
        out = out.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
            const args = inner
                .split('|')
                .map((a) => a.trim())
                .filter((a) => a.length > 0 && !a.includes('='));
            const last = args[args.length - 1];
            return args.length >= 2 && last && !/^https?:\/\//i.test(last) ? last : '';
        });
    }
    return out.replace(/\{\{|\}\}/g, '');
};

/** `[[Target|Label]]` → Label, `[[Target]]` → Target, `[[wikipedia:X|Article]]` → Article. */
const stripLinks = (s: string): string =>
    s.replace(/\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target);

/**
 * Turn a MediaWiki search snippet (raw wikitext of the work page) into a line
 * of prose: keep human fields and list items, drop file names, thumbnails,
 * uploader and template plumbing.
 */
export const cleanSnippet = (raw: string | undefined): string => {
    if (!raw) {
        return '';
    }
    const text = decodeEntities(raw.replace(/<[^>]+>/g, ''));
    const kept: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.trim().replace(/^\.\.\.\s*/, '');
        if (!line) {
            continue;
        }
        // "...ilename=TN-..." — a field name cut mid-word by the snippet window;
        // "#REDIRECT [[...]]" — a nickname page pointing at the work.
        if (/^[a-z]*(?:ile ?name|humb)\s*=/i.test(line) || /^#?\s*redirect\b/i.test(line)) {
            continue;
        }
        const field = line.match(/^\|?\s*([^=|]{2,40}?)\s*(?:\d+)?\s*=\s*(.*)$/);
        if (field) {
            const name = (field[1] ?? '').trim().toLowerCase();
            if (!SNIPPET_FIELDS.has(name)) {
                continue;
            }
            line = field[2] ?? '';
        }
        line = stripLinks(stripTemplates(line));
        line = line
            .replace(/^=+\s*(.*?)\s*=+$/, '$1')
            .replace(/^[#*:;]+\s*/, '')
            .replace(/'{2,}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (line.length < 3 || MEDIA_FILE_RE.test(line) || /^source:?$/i.test(line)) {
            continue;
        }
        kept.push(line);
        if (kept.join(' · ').length >= SNIPPET_MAX) {
            break;
        }
    }
    const joined = kept.join(' · ');
    return joined.length > SNIPPET_MAX ? `${joined.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : joined;
};

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
    /**
     * Hard filter: a hit must be in at least one category of EVERY group
     * (OR within a group, AND across groups — e.g. [[For piano, For piano (arr)],
     * [Baroque]]). Empty or absent means no hard filter.
     */
    requiredGroups?: string[][];
    /**
     * Folded titles whose category lookup never completed. Under
     * requiredGroups they mean "unknown", not "not a member" — an upstream
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
                    existing.snippet = cleanSnippet(hit.snippet);
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
                    snippet: cleanSnippet(hit.snippet),
                    timestamp: hit.timestamp ?? null,
                    score: bonus,
                });
            }
        });
    }

    const groups = (opts.requiredGroups ?? []).filter((g) => g.length > 0);
    const satisfiesGroups = (categories: Set<string> | undefined): boolean =>
        groups.every((group) => group.some((c) => categories?.has(c) ?? false));

    const ranked: RankedHit[] = [];
    for (const hit of merged.values()) {
        const folded = foldAccents(hit.title);
        const categories = opts.categoryHits?.get(folded);
        if (groups.length > 0 && !opts.unverifiedTitles?.has(folded) && !satisfiesGroups(categories)) {
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
