import type { ImportProposal, PageProposal, ProposedItem } from '@/features/import/importTypes';
import { isTextPayload, type Annotation } from '@/types/models';

/**
 * Leave out of a scan what an earlier Import marks already brought in.
 *
 * Re-running Import marks without lifting the original ink scans the same ink
 * again, and detection is deterministic: the same file proposes the same
 * marks, which were all imported a second time on top of the first — invisible
 * on screen (the copies sit exactly over each other) until erasing one seemed
 * not to work. Proposal ids are fresh UUIDs every run, so nothing on the item
 * itself says it was seen before; where it sits does.
 *
 * An item is already imported when EVERY annotation in it lands on a live
 * imported mark (`src: 1`) of the same kind on the same page: strokes by the
 * box their points span, text by its anchor. Each existing mark answers for one
 * proposed annotation only, so ink that genuinely appears twice is not folded
 * into one. Colour and wording are not compared — a teacher who recoloured an
 * imported mark, or corrected what the AI read, still has it — and a mark they
 * erased is not live, so running the import again is how it comes back.
 *
 * Not caught: a mark imported as ink before recognition was available and now
 * read as text (or the reverse). That changes its kind, and the review lists it
 * like any other mark, to keep or uncheck.
 */

/** Normalized page units. Two scans of one file agree exactly; this only absorbs float noise. */
const MATCH_TOLERANCE = 0.002;

interface Footprint {
    kind: Annotation['kind'];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

const footprintOf = (annotation: Annotation): Footprint | null => {
    const { payload } = annotation;
    if (isTextPayload(payload)) {
        return { kind: annotation.kind, x0: payload.x, y0: payload.y, x1: payload.x, y1: payload.y };
    }
    const pts = payload.pts;
    if (pts.length < 3) {
        return null;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 3) {
        const x = pts[i] ?? 0;
        const y = pts[i + 1] ?? 0;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    }
    return { kind: annotation.kind, x0, y0, x1, y1 };
};

const sameFootprint = (a: Footprint, b: Footprint): boolean =>
    a.kind === b.kind &&
    Math.abs(a.x0 - b.x0) <= MATCH_TOLERANCE &&
    Math.abs(a.y0 - b.y0) <= MATCH_TOLERANCE &&
    Math.abs(a.x1 - b.x1) <= MATCH_TOLERANCE &&
    Math.abs(a.y1 - b.y1) <= MATCH_TOLERANCE;

const isImported = (annotation: Annotation): boolean =>
    annotation.deletedAt === null && (annotation.payload as { src?: number }).src === 1;

export interface DedupedProposal {
    /** The scan without them; a page left with nothing is dropped. */
    proposal: ImportProposal;
    /**
     * Review items left out because they were imported before. Kept rather
     * than discarded: lifting the original ink still has to reach them, or a
     * page imported once without lifting could never be cleaned.
     */
    skipped: ProposedItem[];
}

export const dropAlreadyImported = (proposal: ImportProposal, existing: readonly Annotation[]): DedupedProposal => {
    const byPage = new Map<number, Footprint[]>();
    for (const annotation of existing) {
        if (annotation.docId !== proposal.docId || !isImported(annotation)) {
            continue;
        }
        const footprint = footprintOf(annotation);
        if (footprint) {
            const list = byPage.get(annotation.page) ?? [];
            list.push(footprint);
            byPage.set(annotation.page, list);
        }
    }
    if (byPage.size === 0) {
        return { proposal, skipped: [] };
    }

    const skipped: ProposedItem[] = [];
    const pages: PageProposal[] = [];
    for (const page of proposal.pages) {
        const pool = byPage.get(page.pageIndex);
        if (!pool || pool.length === 0) {
            pages.push(page);
            continue;
        }
        const items: ProposedItem[] = [];
        for (const item of page.items) {
            // Claimed tentatively, and handed back unless the whole item matched.
            const claimed: number[] = [];
            const matched =
                item.annotations.length > 0 &&
                item.annotations.every((annotation) => {
                    const footprint = footprintOf(annotation);
                    if (!footprint) {
                        return false;
                    }
                    const at = pool.findIndex(
                        (candidate, i) => !claimed.includes(i) && sameFootprint(candidate, footprint),
                    );
                    if (at < 0) {
                        return false;
                    }
                    claimed.push(at);
                    return true;
                });
            if (matched) {
                skipped.push(item);
                // Highest index first, so the earlier indices stay valid.
                for (const at of claimed.sort((a, b) => b - a)) {
                    pool.splice(at, 1);
                }
            } else {
                items.push(item);
            }
        }
        if (items.length > 0) {
            pages.push(items.length === page.items.length ? page : { ...page, items });
        }
    }
    return skipped.length === 0 ? { proposal, skipped } : { proposal: { ...proposal, pages }, skipped };
};
