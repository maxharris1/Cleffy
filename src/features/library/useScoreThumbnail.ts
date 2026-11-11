import { useEffect, useState, type RefObject } from 'react';

import { getThumbnail } from '@/features/library/thumbnailService';

/** How far outside the viewport a card may be and still count as "coming up". */
const NEAR_VIEWPORT_MARGIN = '200px';

/**
 * One observer for every card on the shelf. A library of six hundred scores
 * used to create six hundred IntersectionObservers, and the browser checks
 * each one separately on every scrolled frame; one observer watching six
 * hundred targets is a single pass.
 */
let sharedObserver: IntersectionObserver | null = null;
const nearCallbacks = new Map<Element, () => void>();

const observeNear = (el: Element, onNear: () => void): (() => void) => {
    sharedObserver ??= new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }
                const callback = nearCallbacks.get(entry.target);
                if (callback) {
                    nearCallbacks.delete(entry.target);
                    sharedObserver?.unobserve(entry.target);
                    callback();
                }
            }
        },
        { rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    nearCallbacks.set(el, onNear);
    sharedObserver.observe(el);
    return () => {
        if (nearCallbacks.delete(el)) {
            sharedObserver?.unobserve(el);
        }
    };
};

/**
 * True once the element has been on (or within a couple of hundred pixels of)
 * the screen, and stays true: a cover fetched once is kept, so there is nothing
 * to gain by forgetting. Browsers without IntersectionObserver — and the test
 * environment — count everything as visible.
 */
export const useNearViewport = (ref: RefObject<Element | null>): boolean => {
    const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

    useEffect(() => {
        const el = ref.current;
        if (near || !el || typeof IntersectionObserver === 'undefined') {
            return;
        }
        return observeNear(el, () => setNear(true));
    }, [ref, near]);

    return near;
};

/**
 * Object URL for a score's rendered first page, or null while there is nothing
 * to show.
 *
 * Shared by the list row's thumbnail and the shelf card's cover so both go
 * through the same single-flight service. Nothing is asked for until the card
 * is near the viewport: a library of a hundred scores must not start a
 * hundred renders or downloads for cards nobody has scrolled to. The URL is
 * revoked on unmount: the blobs are tens of KB each and a scrolled shelf
 * mints one per visible score.
 */
export const useScoreThumbnail = (
    docId: string,
    contentRev: number,
    options: { thumbRev?: number | null; enabled?: boolean } = {},
): string | null => {
    const { thumbRev = null, enabled = true } = options;
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        let objectUrl: string | null = null;
        getThumbnail(docId, contentRev, thumbRev)
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
    }, [docId, contentRev, thumbRev, enabled]);

    return url;
};
