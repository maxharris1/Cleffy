import { useEffect, useState } from 'react';

import { getThumbnail } from '@/features/library/thumbnailService';

/**
 * Object URL for a score's rendered first page, or null while there is nothing
 * to show.
 *
 * Shared by the list row's thumbnail and the shelf card's cover so both go
 * through the same single-flight, offline-only service. The URL is revoked on
 * unmount: the blobs are hundreds of KB each and a scrolled shelf mints one per
 * visible score.
 */
export const useScoreThumbnail = (docId: string, contentRev: number): string | null => {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | null = null;
        getThumbnail(docId, contentRev)
            .then((blob) => {
                if (blob && !cancelled) {
                    objectUrl = URL.createObjectURL(blob);
                    setUrl(objectUrl);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [docId, contentRev]);

    return url;
};
