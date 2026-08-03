import { rebuildCleanedPdf } from '@/features/import/rebuildPdf';
import { replaceDocumentPdf } from '@/features/library/documentsService';
import type { CleanFn } from '@/features/import/importTypes';
import type { DocumentRow } from '@/types/database';

/**
 * The owner-side clean-and-replace step handed to the review panel: rebuild
 * the PDF with accepted ink lifted off, swap the stored file (backup kept),
 * and hand the fresh bytes/row back to the viewer so it re-renders without a
 * reload. Content_rev fans out to collaborators via the documents trigger.
 */
export const buildCleanFn = (
    doc: DocumentRow,
    sourceBytes: ArrayBuffer,
    onReplaced: (updated: DocumentRow, newBytes: ArrayBuffer) => void,
): CleanFn => {
    return async (proposal, acceptedItems, onStep) => {
        onStep('rebuild');
        const newBytes = await rebuildCleanedPdf(sourceBytes, proposal, acceptedItems);
        onStep('upload');
        const updated = await replaceDocumentPdf(doc, sourceBytes, newBytes);
        // Hand the viewer a buffer it owns (worker transfer already detached ours from the worker side).
        const copy = new Uint8Array(newBytes.byteLength);
        copy.set(newBytes);
        onReplaced(updated, copy.buffer);
    };
};
