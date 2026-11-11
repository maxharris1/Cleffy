import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A value that shows for `ms` and then clears itself — "Copied!" on a button.
 * One timer, held in a ref: flashing again restarts it (a second copy within
 * the window no longer has the first copy's timer clear the label early), and
 * unmounting cancels it (no state update on a closed dialog).
 */
export const useFlash = <T>(ms: number): [T | null, (value: T) => void] => {
    const [value, setValue] = useState<T | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flash = useCallback(
        (next: T) => {
            if (timer.current !== null) {
                clearTimeout(timer.current);
            }
            setValue(next);
            timer.current = setTimeout(() => {
                timer.current = null;
                setValue(null);
            }, ms);
        },
        [ms],
    );

    useEffect(
        () => () => {
            if (timer.current !== null) {
                clearTimeout(timer.current);
            }
        },
        [],
    );

    return [value, flash];
};

/**
 * Shorten from the middle, keeping both ends: a share URL's origin says where
 * it goes and its last characters tell two links apart; the middle says
 * nothing. Full text stays available to the caller (title, aria-label, copy).
 */
export const middleEllipsis = (text: string, max = 36): string => {
    if (text.length <= max) {
        return text;
    }
    const tail = Math.max(6, Math.floor((max - 1) / 3));
    const head = max - 1 - tail;
    return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};
