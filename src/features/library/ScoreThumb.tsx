import { useEffect, useState } from 'react';

import { getThumbnail } from '@/features/library/thumbnailService';

/**
 * First-page preview for a library row. Purely decorative — the row's
 * stretched title link covers it, so it is `aria-hidden` and never focusable.
 * Falls back to a drawn staff whenever no render exists yet (score not cached
 * on this device, render still queued, or a PDF pdf.js could not open).
 */
export const ScoreThumb = ({ docId, contentRev }: { docId: string; contentRev: number }) => {
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

    return (
        <span
            aria-hidden="true"
            className="block h-12 w-9 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-white"
        >
            {url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : <StaffPlaceholder />}
        </span>
    );
};

const StaffPlaceholder = () => (
    <svg viewBox="0 0 36 48" className="h-full w-full text-stone-300" aria-hidden="true">
        {[15, 19.5, 24, 28.5, 33].map((y) => (
            <line key={y} x1={5} x2={31} y1={y} y2={y} stroke="currentColor" strokeWidth={1} />
        ))}
    </svg>
);
