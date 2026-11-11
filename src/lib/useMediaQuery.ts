import { useCallback, useSyncExternalStore } from 'react';

const canMatch = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/**
 * Whether a media query matches, kept current as the viewport changes (an
 * iPad rotated, a window resized past a breakpoint). False where there is no
 * matchMedia to ask (the server, older test environments).
 */
export const useMediaQuery = (query: string): boolean => {
    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!canMatch()) {
                return () => undefined;
            }
            const list = window.matchMedia(query);
            list.addEventListener('change', onChange);
            return () => list.removeEventListener('change', onChange);
        },
        [query],
    );
    return useSyncExternalStore(
        subscribe,
        () => canMatch() && window.matchMedia(query).matches,
        () => false,
    );
};
