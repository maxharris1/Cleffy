import { useMemo, useState } from 'react';

import { buildFingeringProposals } from '@/features/fingering/applyFingerings';
import { bindRegionDigits } from '@/features/fingering/bindFingerings';
import { readCachedRegion, regionCacheKey, writeCachedRegion } from '@/features/fingering/cache';
import { FingeringDiagramPanel } from '@/features/fingering/diagram/FingeringDiagramPanel';
import { FingeringReviewPanel } from '@/features/fingering/FingeringReviewPanel';
import { FingeringSelectionPopover } from '@/features/fingering/FingeringSelectionPopover';
import { emptyRegion, type FingeringSequence, type Hand, type NormRect, type RecognizedRegion } from '@/features/fingering/model';
import { buildRegionImages } from '@/features/fingering/regionCrop';
import { makeRecognizeNotesFn } from '@/features/fingering/recognizeApi';
import { isCloudDocId } from '@/features/library/documentsService';
import { pagePointToViewport, type PageLayout } from '@/features/viewer/geometry';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
import type { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';
import type { Annotation } from '@/types/models';
import { buttonClassName } from '@/ui/classNames';

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

type Phase = 'choose' | 'recognizing' | 'review' | 'diagram' | 'applying';

/** Matches the edge function's cap — checked client-side for a friendly message. */
const MAX_REGION_AREA = 0.5;

/**
 * Orchestrates one fingering interaction: selection highlight → action popover
 * → note recognition (or manual entry) → review → keyboard diagram. Mounted
 * lazily by PdfViewport per selection (keyed remount resets the flow).
 */
export const FingeringFlow = ({ docId, selection, layout, store, canWrite, onClose }: FingeringFlowProps) => {
    const view = useViewerStore((s) => s.view);
    const { doc } = usePdf();
    const [phase, setPhase] = useState<Phase>('choose');
    /** Set on review confirm — the flow's source of truth for the diagram. */
    const [region, setRegion] = useState<RecognizedRegion | null>(null);
    /** Vision result awaiting review (cleared once confirmed into `region`). */
    const [visionSeed, setVisionSeed] = useState<RecognizedRegion | null>(null);
    const [snapshot, setSnapshot] = useState<{ dataUrl: string; rect: NormRect } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingProposals, setPendingProposals] = useState<Annotation[]>([]);
    const [cacheKey, setCacheKey] = useState<string | null>(null);
    const [fromCache, setFromCache] = useState(false);
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
            const aspect = layout.width / layout.height;
            const db = getDb();

            // A prior reading of this exact region (same PDF revision, same
            // nearby annotations) is served from cache — corrections included.
            const contentRev = (await db.pdfCache.get(docId))?.contentRev ?? 0;
            const key = await regionCacheKey({
                docId,
                page: selection.pageIndex,
                rect,
                contentRev,
                annotations,
                aspect,
            });
            setCacheKey(key);

            const images = await buildRegionImages(doc, selection.pageIndex, rect, annotations);
            setSnapshot({
                dataUrl: `data:${images.regionImage.mediaType};base64,${images.regionImage.dataBase64}`,
                rect: images.cropRect,
            });

            const cached = await readCachedRegion(db, key);
            if (cached) {
                setVisionSeed(cached);
                setFromCache(true);
                setPhase('review');
                return;
            }

            const recognized = await recognize(selection.pageIndex, rect, images);
            if (!recognized || recognized.notes.length === 0) {
                setError("Couldn't read the passage — enter the notes by hand.");
                setPhase('choose');
                return;
            }
            setVisionSeed(bindRegionDigits(recognized, annotations, aspect));
            setFromCache(false);
            setPhase('review');
        } catch {
            setError("Couldn't read the passage — enter the notes by hand.");
            setPhase('choose');
        }
    };

    /** Preview suggested digits on the page via the store's overlay mechanism. */
    const startApply = (sequences: Record<Hand, FingeringSequence | null>) => {
        if (!region) {
            return;
        }
        const proposals = buildFingeringProposals({
            region,
            sequences,
            existing: [...store.getPage(selection.pageIndex).values()],
            aspect: layout.width / layout.height,
            docId,
        });
        if (proposals.length === 0) {
            setError('Every suggested fingering is already written on the score.');
            return;
        }
        setError(null);
        setPendingProposals(proposals);
        store.setHistoryOverlay([...store.liveAnnotations(), ...proposals], 'preview');
        setPhase('applying');
    };

    const finishApply = async (commit: boolean) => {
        // Clear the overlay FIRST — createMany is a no-op while it is shown.
        store.setHistoryOverlay(null);
        if (commit && pendingProposals.length > 0) {
            store.beginBatch();
            try {
                await store.createMany(pendingProposals);
            } finally {
                store.endBatch();
            }
        }
        setPendingProposals([]);
        setPhase('diagram');
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
                    fromCache={fromCache}
                    onConfirm={(next) => {
                        setRegion(next);
                        setPhase('diagram');
                        if (cacheKey && next.source === 'vision') {
                            void writeCachedRegion(getDb(), cacheKey, next);
                        }
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
                <>
                    {error ? (
                        <div
                            data-ui-overlay
                            className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-2"
                        >
                            <p className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900 shadow">
                                {error}
                            </p>
                        </div>
                    ) : null}
                    <FingeringDiagramPanel
                        region={region}
                        canApply={canWrite}
                        onApply={startApply}
                        onEditNotes={() => setPhase('review')}
                        onClose={onClose}
                    />
                </>
            ) : null}
            {phase === 'applying' ? (
                <div data-ui-overlay className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
                    <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-sm text-teal-950 shadow">
                        <span>
                            Previewing {pendingProposals.length} suggested fingering
                            {pendingProposals.length === 1 ? '' : 's'}
                        </span>
                        <button
                            type="button"
                            onClick={() => void finishApply(true)}
                            className={buttonClassName('primary', 'sm', 'px-2.5 py-1 text-xs')}
                        >
                            Add to score
                        </button>
                        <button
                            type="button"
                            onClick={() => void finishApply(false)}
                            className={buttonClassName('ghost', 'sm', 'px-2.5 py-1 text-xs')}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}
        </>
    );
};
