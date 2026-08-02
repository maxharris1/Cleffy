/**
 * Search query helpers for IMSLP MediaWiki search.
 * MW treats multi-word queries as AND — "beethoven moonlight" often returns 0 —
 * so we fan out variants and re-rank client-side (in the edge function).
 */

export const foldAccents = (s: string): string =>
    s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Nickname / common misspellings → exact IMSLP work titles (boosted to top). */
export const SEARCH_ALIASES: Array<{ keys: string[]; title: string }> = [
    {
        keys: ['moonlight', 'moonlight sonata'],
        title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
    },
    {
        keys: ['fur elise', 'fuer elise', 'für elise'],
        title: 'Für Elise, WoO 59 (Beethoven, Ludwig van)',
    },
    {
        keys: ['pathetique', 'pathétique', 'pathetique sonata'],
        title: 'Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)',
    },
    {
        keys: ['clair de lune', 'clairdelune'],
        title: 'Suite bergamasque, CD 82 (Debussy, Claude)',
    },
    {
        keys: ['bolero', 'boléro'],
        title: 'Boléro, M.81 (Ravel, Maurice)',
    },
    {
        keys: ['nimrod', 'enigma', 'enigma variations'],
        title: "Variations on an Original Theme 'Enigma', Op.36 (Elgar, Edward)",
    },
    {
        keys: ['lullaby', 'brahms lullaby', 'wiegenlied'],
        title: 'Wiegenlied, Op.49 No.4 (Brahms, Johannes)',
    },
    {
        keys: ['alla turca', 'turkish march', 'rondo alla turca'],
        title: 'Piano Sonata No.11, K.331/300i (Mozart, Wolfgang Amadeus)',
    },
    {
        keys: ['eine kleine', 'nachtmusik', 'eine kleine nachtmusik'],
        title: 'Serenade in G major, K.525 (Mozart, Wolfgang Amadeus)',
    },
    {
        keys: ['four seasons', 'le quattro stagioni', 'vivaldi spring'],
        title: 'Le quattro stagioni (Vivaldi, Antonio)',
    },
    {
        keys: ['bumblebee', 'flight of the bumblebee'],
        title: 'The Tale of Tsar Saltan (Rimsky-Korsakov, Nikolay)',
    },
    {
        keys: ['blue danube', 'donau'],
        title: 'An der schönen blauen Donau, Op.314 (Strauss Jr., Johann)',
    },
    {
        keys: ['canon in d', 'pachelbel canon'],
        title: 'Canon and Gigue in D major, P.37 (Pachelbel, Johann)',
    },
    {
        keys: ['gymnopedie', 'gymnopédie'],
        title: '3 Gymnopédies (Satie, Erik)',
    },
];

export const tokenizeQuery = (q: string): string[] =>
    q
        .split(/[\s,./+\-_|]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);

/** Build a small set of MediaWiki search strings from the user query. */
export const buildSearchVariants = (q: string): string[] => {
    const trimmed = q.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
        return [];
    }
    const folded = foldAccents(trimmed);
    const tokens = tokenizeQuery(trimmed);
    const variants: string[] = [trimmed];

    if (folded !== trimmed.toLowerCase()) {
        variants.push(folded);
    }

    // Multi-word: also search significant tokens alone (AND is too strict otherwise).
    if (tokens.length >= 2) {
        for (const tok of tokens) {
            if (tok.length >= 3) {
                variants.push(tok);
            }
        }
        if (tokens.length >= 3) {
            variants.push(tokens.slice(0, 2).join(' '));
            variants.push(tokens.slice(-2).join(' '));
        }
    }

    // Alias keys that appear in the query → search the canonical title too.
    const foldedQ = foldAccents(trimmed);
    for (const alias of SEARCH_ALIASES) {
        if (alias.keys.some((k) => foldedQ.includes(foldAccents(k)))) {
            variants.push(alias.title);
            break;
        }
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of variants) {
        const key = foldAccents(v);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(v);
        if (out.length >= 6) {
            break;
        }
    }
    return out;
};

export const aliasTitlesForQuery = (q: string): string[] => {
    const foldedQ = foldAccents(q.trim());
    const titles: string[] = [];
    for (const alias of SEARCH_ALIASES) {
        if (alias.keys.some((k) => foldedQ.includes(foldAccents(k)) || foldAccents(k) === foldedQ)) {
            titles.push(alias.title);
        }
    }
    return titles;
};

export const scoreTitleMatch = (title: string, tokens: string[]): number => {
    if (tokens.length === 0) {
        return 0;
    }
    const foldedTitle = foldAccents(title);
    const composerMatch = title.match(/\(([^)]+)\)\s*$/);
    const foldedComposer = composerMatch ? foldAccents(composerMatch[1] ?? '') : '';

    let score = 0;
    for (const tok of tokens) {
        const t = foldAccents(tok);
        if (t.length < 2) {
            continue;
        }
        if (foldedTitle.includes(t)) {
            score += 3;
        }
        if (foldedComposer.includes(t)) {
            score += 4;
        }
    }
    // Bonus when every token hits somewhere in the title.
    const hits = tokens.filter((tok) => foldAccents(tok).length >= 2 && foldedTitle.includes(foldAccents(tok)));
    if (hits.length === tokens.length && tokens.length > 1) {
        score += 8;
    }
    return score;
};
