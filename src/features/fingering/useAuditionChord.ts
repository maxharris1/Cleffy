import { useEffect, useState } from 'react';

import { auditionNotes, stopAudition } from '@/features/playback/auditionNotes';

/**
 * Hear-button state for review/diagram — cancels on unmount so buffer loads
 * cannot start voices after the panel closes.
 */
export const useAuditionChord = () => {
    const [hearing, setHearing] = useState(false);

    useEffect(() => () => stopAudition(), []);

    const hear = (midis: readonly number[]) => {
        if (midis.length === 0 || hearing) {
            return;
        }
        setHearing(true);
        void auditionNotes(midis).finally(() => setHearing(false));
    };

    return { hearing, hear };
};
