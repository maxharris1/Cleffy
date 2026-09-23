/**
 * Product hook for the play-along corpus in the OMR job: the hash / layout
 * lookups before symbolic-first and OMR, and the organic `corpusPut` on a
 * public accept or an IMSLP / corpus-owner OMR result.
 *
 * Unset / empty → off in production: no corpus RPC is ever called and the job
 * (and its timings) is byte-identical to the pre-corpus worker. Independent of
 * CLEFFY_SYMBOLIC_FIRST so an OMR corpus hit still serves when symbolic is off.
 */
export const CORPUS_LOOKUP_ENV = 'CLEFFY_CORPUS_LOOKUP';

/**
 * auth.users id of the corpus owner (`corpus@cleffy.app`). OMR results for
 * documents this user created are seed runs and may be written to the corpus.
 */
export const CORPUS_OWNER_ENV = 'CLEFFY_CORPUS_OWNER_USER_ID';

export const isCorpusLookupEnabled = (raw: string | undefined = process.env[CORPUS_LOOKUP_ENV]): boolean => {
    const v = raw?.trim().toLowerCase();
    if (v === undefined || v === '') {
        return false;
    }
    switch (v) {
        case '1':
        case 'true':
        case 'on':
        case 'yes':
            return true;
        case '0':
        case 'false':
        case 'off':
        case 'no':
            return false;
        default:
            return false;
    }
};

export const corpusOwnerUserId = (raw: string | undefined = process.env[CORPUS_OWNER_ENV]): string | null => {
    const v = raw?.trim();
    return v ? v : null;
};
