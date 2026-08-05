import { useMemo, useState } from 'react';

import { FingeringDiagramPanel } from '@/features/fingering/diagram/FingeringDiagramPanel';
import { FingeringReviewPanel } from '@/features/fingering/FingeringReviewPanel';
import { FingeringSelectionPopover } from '@/features/fingering/FingeringSelectionPopover';
import { emptyRegion, type NormRect, type RecognizedRegion } from '@/features/fingering/model';
import { pagePointToViewport, type PageLayout } from '@/features/viewer/geometry';
import type { AnnotationStore } from '@/sync/annotationStore';
import { useViewerStore } from '@/state/store';

export interface FingeringFlowProps {
    docId: string;
    selection: { pageIndex: number; rect: NormRect };
    /** Layout of the selection's page (base units). */
    layout: PageLayout;
    store: AnnotationStore;
    /** Owner/editor — gates the M3 apply-to-score action. */
    canWrite: boolean;
    onClose: () => void;
}

type Phase = 'choose' | 'review' | 'diagram';

/**
 * Orchestrates one fingering interaction: selection highlight → action popover
 * → note review/entry → keyboard diagram. Mounted lazily by PdfViewport per
 * selection (keyed remount resets the flow).
 */
export const FingeringFlow = ({ docId, selection, layout, onClose }: FingeringFlowProps) => {
    const view = useViewerStore((s) => s.view);
    const [phase, setPhase] = useState<Phase>('choose');
    /** Set on review confirm — the flow's source of truth for the diagram. */
    const [region, setRegion] = useState<RecognizedRegion | null>(null);

    const { rect } = selection;
    const topLeft = pagePointToViewport(view, layout, rect.x, rect.y);
    const bottomRight = pagePointToViewport(view, layout, rect.x + rect.w, rect.y + rect.h);

    const reviewSeed = useMemo(
        () => region ?? emptyRegion(docId, selection.pageIndex, rect),
        [region, docId, selection.pageIndex, rect],
    );

    return (
        <>
            <div
                data-ui-overlay
                aria-hidden
                className="pointer-events-none absolute z-20 rounded border-2 border-accent/70 bg-accent/5"
                style={{
                    left: topLeft.x,
                    top: topLeft.y,
                    width: bottomRight.x - topLeft.x,
                    height: bottomRight.y - topLeft.y,
                }}
            />
            {phase === 'choose' ? (
                <FingeringSelectionPopover
                    anchorX={(topLeft.x + bottomRight.x) / 2}
                    anchorY={bottomRight.y}
                    onReadNotes={null}
                    onEnterNotes={() => setPhase('review')}
                    onCancel={onClose}
                />
            ) : null}
            {phase === 'review' ? (
                <FingeringReviewPanel
                    initial={reviewSeed}
                    onConfirm={(next) => {
                        setRegion(next);
                        setPhase('diagram');
                    }}
                    onCancel={() => {
                        if (region) {
                            setPhase('diagram');
                        } else {
                            onClose();
                        }
                    }}
                />
            ) : null}
            {phase === 'diagram' && region ? (
                <FingeringDiagramPanel region={region} onEditNotes={() => setPhase('review')} onClose={onClose} />
            ) : null}
        </>
    );
};
