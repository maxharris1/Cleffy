import { useEffect, useState } from 'react';

/** The landing page's handwriting face (landing.css). */
const HANDWRITING = '500 1em Caveat';

/** Past this, write the notes in whatever face there is rather than hold them back. */
const GIVE_UP_MS = 3000;

/**
 * True once the handwriting face has loaded (or failed, or taken too long),
 * so a score note is never seen being written in a fallback face. True from
 * the start where the browser has no font loading API (jsdom) or already has
 * the face.
 */
export const useHandwritingReady = (): boolean => {
    const [ready, setReady] = useState(() => {
        if (typeof document === 'undefined' || !('fonts' in document)) {
            return true;
        }
        try {
            return document.fonts.check(HANDWRITING);
        } catch {
            return true;
        }
    });

    useEffect(() => {
        if (ready) {
            return;
        }
        let done = false;
        const settle = () => {
            if (!done) {
                done = true;
                setReady(true);
            }
        };
        const timer = window.setTimeout(settle, GIVE_UP_MS);
        document.fonts.load(HANDWRITING).then(settle, settle);
        return () => {
            done = true;
            window.clearTimeout(timer);
        };
    }, [ready]);

    return ready;
};
