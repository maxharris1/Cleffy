import type { DocumentLayout } from '@/features/viewer/geometry';
import { useViewerStore } from '@/state/store';
import type { ScoreData } from '@/types/scoreData';

/**
 * The practice loop, drawn on the music itself: a soft band over every bar in
 * range with solid brackets at the two ends, so "which bars repeat" is a thing
 * you read off the score instead of off the transport. Amber keeps it distinct
 * from the accent-tinted playhead measure sweeping through it. Declarative
 * React is fine here — the range only changes on explicit user action.
 * Rendered inside PdfViewport's transformed wrapper (base units × renderScale).
 */

/** On-screen size of the "Loop" tag, in CSS px, at any zoom. */
const LOOP_TAG_PX = 11;

export const LoopRangeOverlay = ({
    score,
    layout,
    renderScale,
}: {
    score: ScoreData;
    layout: DocumentLayout;
    renderScale: number;
}) => {
    const loopRange = useViewerStore((s) => s.loopRange);
    const viewScale = useViewerStore((s) => s.view.scale);
    if (!loopRange) {
        return null;
    }
    // The wrapper positions children in base units × renderScale and then
    // scales the lot by view.scale / renderScale. Undoing that leaves the tag
    // a constant size on screen — it is a marker, not engraving, and sizing it
    // off the staff made it balloon on tall systems and at high zoom.
    const tagPx = (LOOP_TAG_PX * renderScale) / Math.max(0.01, viewScale);
    const rects = [];
    for (let i = loopRange.a; i <= loopRange.b && i < score.measures.length; i++) {
        const measure = score.measures[i];
        if (!measure || measure.sys < 0) {
            continue;
        }
        const system = score.systems[measure.sys];
        const pageLayout = layout.layouts[measure.page];
        if (!system || !pageLayout) {
            continue;
        }
        const left = (pageLayout.left + measure.x0 * pageLayout.width) * renderScale;
        const top = (pageLayout.top + system.y0 * pageLayout.height) * renderScale;
        const width = (measure.x1 - measure.x0) * pageLayout.width * renderScale;
        const height = (system.y1 - system.y0) * pageLayout.height * renderScale;
        rects.push(
            <div
                key={i}
                className={[
                    'pointer-events-none absolute bg-amber-400/15',
                    i === loopRange.a ? 'rounded-l-sm border-l-2 border-amber-500' : '',
                    i === loopRange.b ? 'rounded-r-sm border-r-2 border-amber-500' : '',
                ].join(' ')}
                style={{ left, top, width, height }}
            >
                {i === loopRange.a ? (
                    <span
                        className="absolute left-0 -translate-y-full whitespace-nowrap bg-amber-500 font-medium leading-snug text-white"
                        // Padding/radius in em so they track the corrected size.
                        style={{
                            fontSize: tagPx,
                            top: -tagPx * 0.25,
                            padding: '0 0.35em',
                            borderRadius: '0.2em',
                        }}
                    >
                        Loop
                    </span>
                ) : null}
            </div>,
        );
    }
    return <>{rects}</>;
};
