import { useEffect, useState } from 'react';

const HANDWRITING = '500 1em Caveat';

const GIVE_UP_MS = 3000;

/**
 * Where the handwriting face stands. `gave-up` once it failed or took longer
 * than GIVE_UP_MS; a late load still moves it on to `loaded`.
 */
export type HandwritingFont = 'pending' | 'loaded' | 'gave-up';

const initialFont = (): HandwritingFont => {
    if (typeof document === 'undefined' || !('fonts' in document)) {
        return 'loaded';
    }
    try {
        return document.fonts.check(HANDWRITING) ? 'loaded' : 'pending';
    } catch {
        return 'loaded';
    }
};

export const useHandwritingFont = (): HandwritingFont => {
    const [font, setFont] = useState(initialFont);
    const loaded = font === 'loaded';

    useEffect(() => {
        if (loaded) {
            return;
        }
        let current = true;
        const giveUp = () => {
            if (current) {
                setFont((state) => (state === 'pending' ? 'gave-up' : state));
            }
        };
        const timer = window.setTimeout(giveUp, GIVE_UP_MS);
        document.fonts.load(HANDWRITING).then(() => {
            if (current) {
                setFont('loaded');
            }
        }, giveUp);
        return () => {
            current = false;
            window.clearTimeout(timer);
        };
    }, [loaded]);

    return font;
};
