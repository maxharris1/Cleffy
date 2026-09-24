/**
 * Product hook for the symbolic-first path in the OMR job.
 *
 * Unset / empty → off in production. Eval sets `CLEFFY_SYMBOLIC_FIRST=1`
 * (see package.json `eval` and the symbolic CLI). Max flips prod on by
 * exporting the same value on the worker.
 */
export const SYMBOLIC_FIRST_ENV = 'CLEFFY_SYMBOLIC_FIRST';

export const isSymbolicFirstEnabled = (raw: string | undefined = process.env[SYMBOLIC_FIRST_ENV]): boolean => {
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
