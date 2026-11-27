import { useEffect, useState } from 'react';

/** The landing page's handwriting face (landing.css). */
const HANDWRITING = '500 1em Caveat';

/** Never times out into the fallback face: the notes stay hidden until Caveat loads. */
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
        let current = true;
        document.fonts.load(HANDWRITING).then(
            () => {
                if (current) {
                    setReady(true);
                }
            },
            () => {},
        );
        return () => {
            current = false;
        };
    }, [ready]);

    return ready;
};
