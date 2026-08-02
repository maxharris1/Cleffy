import type { DocumentLayout } from '@/features/viewer/geometry';
import { useViewerStore } from '@/state/store';
import type { ScoreData } from '@/types/scoreData';

/**
 * Soft tint over the measures inside the A-B practice loop. Declarative
 * React is fine here — the range only changes on explicit user action.
 * Rendered inside PdfViewport's transformed wrapper (base units × renderScale).
 */
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
    if (!loopRange) {
        return null;
    }
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
        rects.push(
            <div
                key={i}
                className="pointer-events-none absolute rounded-sm bg-accent/10"
                style={{
                    left: (pageLayout.left + measure.x0 * pageLayout.width) * renderScale,
                    top: (pageLayout.top + system.y0 * pageLayout.height) * renderScale,
                    width: (measure.x1 - measure.x0) * pageLayout.width * renderScale,
                    height: (system.y1 - system.y0) * pageLayout.height * renderScale,
                }}
            />,
        );
    }
    return <>{rects}</>;
};
