import { useEffect, useState } from 'react';

/**
 * `flag`, but only once it has stayed true for `delayMs`; false again the
 * moment it goes false. For a state that is usually over before anyone could
 * read it: the sync engine flips to "syncing" after every stroke and back
 * within a few hundred ms, and a dot that blinks amber all lesson says
 * nothing. Only a sync that is still going after the delay is worth showing.
 */
export const useDelayedFlag = (flag: boolean, delayMs: number): boolean => {
    /** The delay has run out during this stretch of `flag` being true. */
    const [elapsed, setElapsed] = useState(false);

    useEffect(() => {
        if (!flag) {
            return;
        }
        const timer = setTimeout(() => setElapsed(true), delayMs);
        return () => {
            clearTimeout(timer);
            setElapsed(false);
        };
    }, [flag, delayMs]);

    return flag && elapsed;
};
