import { useRef } from 'react';

import { StaffPlaceholder } from '@/features/library/StaffPlaceholder';
import { useNearViewport, useScoreThumbnail } from '@/features/library/useScoreThumbnail';

/**
 * First-page preview for a library row. Purely decorative — the row's
 * stretched title link covers it, so it is `aria-hidden` and never focusable.
 * Falls back to a drawn staff whenever no render exists yet (score not cached
 * on this device and none published, render still queued, or a PDF pdf.js
 * could not open).
 *
 * The shelf card draws the same render at full A4 size; both go through
 * useScoreThumbnail so there is one single-flight path into the cache, and
 * neither asks for anything until the row is near the viewport.
 */
export const ScoreThumb = ({
    docId,
    contentRev,
    thumbRev = null,
}: {
    docId: string;
    contentRev: number;
    thumbRev?: number | null;
}) => {
    const ref = useRef<HTMLSpanElement | null>(null);
    const near = useNearViewport(ref);
    const url = useScoreThumbnail(docId, contentRev, { thumbRev, enabled: near });

    return (
        <span
            ref={ref}
            aria-hidden="true"
            className="block h-12 w-9 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-white"
        >
            {url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : <StaffPlaceholder />}
        </span>
    );
};
