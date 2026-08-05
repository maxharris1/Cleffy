import { useMemo, useState } from 'react';

import { bindRegionDigits } from '@/features/fingering/bindFingerings';
import { FingeringDiagramPanel } from '@/features/fingering/diagram/FingeringDiagramPanel';
import { FingeringReviewPanel } from '@/features/fingering/FingeringReviewPanel';
import { FingeringSelectionPopover } from '@/features/fingering/FingeringSelectionPopover';
import { emptyRegion, type NormRect, type RecognizedRegion } from '@/features/fingering/model';
import { buildRegionImages } from '@/features/fingering/regionCrop';
import { makeRecognizeNotesFn } from '@/features/fingering/recognizeApi';
import { isCloudDocId } from '@/features/library/documentsService';
import { pagePointToViewport, type PageLayout } from '@/features/viewer/geometry';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
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

type Phase = 'choose' | 'recognizing' | 'review' | 'diagram';

/** Matches the edge function's cap — checked client-side for a friendly message. */
const MAX_REGION_AREA = 0.5;

/**
 * Orchestrates one fingering interaction: selection highlight → action popover
 * → note recognition (or manual entry) → review → keyboard diagram. Mounted
 * lazily by PdfViewport per selection (keyed remount resets the flow).
 */
export const FingeringFlow = ({ docId, selection, layout, store, onClose }: FingeringFlowProps) => {
    const view = useViewerStore((s) => s.view);
    const { doc } = usePdf();
    const [phase, setPhase] = useState<Phase>('choose');
    /** Set on review confirm — the flow's source of truth for the diagram. */
    const [region, setRegion] = useState<RecognizedRegion | null>(null);
    /** Vision result awaiting review (cleared once confirmed into `region`). */
    const [visionSeed, setVisionSeed] = useState<RecognizedRegion | null>(null);
    const [snapshot, setSnapshot] = useState<{ dataUrl: string; rect: NormRect } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const recognize = useMemo(() => (isCloudDocId(docId) ? makeRecognizeNotesFn(docId) : null), [docId]);

    const { rect } = selection;
    const topLeft = pagePointToViewport(view, layout, rect.x, rect.y);
    const bottomRight = pagePointToViewport(view, layout, rect.x + rect.w, rect.y + rect.h);

    const reviewSeed = useMemo(
        () => region ?? visionSeed ?? emptyRegion(docId, selection.pageIndex, rect),
        [region, visionSeed, docId, selection.pageIndex, rect],
    );

    const readNotes = async () => {
        if (!recognize || !doc) {
            setPhase('review');
            return;
        }
        if (rect.w * rect.h > MAX_REGION_AREA) {
            setError('That selection covers most of the page — select a shorter passage.');
            return;
        }
        setPhase('recognizing');
        setError(null);
        try {
            const annotations = [...store.getPage(selection.pageIndex).values()];
            const images = await buildRegionImages(doc, selection.pageIndex, rect, annotations);
            const recognized = await recognize(selection.pageIndex, rect, images);
            if (!recognized || recognized.notes.length === 0) {
                setError("Couldn't read the passage — enter the notes by hand.");
                setPhase('choose');
                return;
            }
            const aspect = layout.width / layout.height;
            setVisionSeed(bindRegionDigits(recognized, annotations, aspect));
            setSnapshot({
                dataUrl: `data:${images.regionImage.mediaType};base64,${images.regionImage.dataBase64}`,
                rect: images.cropRect,
            });
            setPhase('review');
        } catch {
            setError("Couldn't read the passage — enter the notes by hand.");
            setPhase('choose');
        }
    };

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
            {phase === 'choose' || phase === 'recognizing' ? (
                <FingeringSelectionPopover
                    anchorX={(topLeft.x + bottomRight.x) / 2}
                    anchorY={bottomRight.y}
                    busy={phase === 'recognizing'}
                    error={error}
                    onReadNotes={recognize && doc ? () => void readNotes() : null}
                    onEnterNotes={() => setPhase('review')}
                    onCancel={onClose}
                />
            ) : null}
            {phase === 'review' ? (
                <FingeringReviewPanel
                    initial={reviewSeed}
                    snapshot={snapshot}
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
