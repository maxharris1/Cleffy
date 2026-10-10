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
 * When that finds no match, the ink the item was read from decides instead, so
 * a mark whose KIND changed between runs is still recognised: imported as ink
 * while recognition was unavailable or over quota and now read as text, or the
 * reverse. A text item is already imported when imported strokes lie inside its
 * ink; an ink item when its ink sits on an imported text note. Recognition can
 * also read the same ink differently ("cresc." then "cresc"); that never
 * mattered, as a text note's anchor comes from the ink, not from the wording.
 */

/** Normalized page units. Two scans of one file agree exactly; this only absorbs float noise. */
const MATCH_TOLERANCE = 0.002;
/**
 * A vectorized stroke follows the centre of its ink, so it lies inside the
 * ink's box; this only absorbs rounding at the box edge.
 */
const INK_SLACK = 0.005;
/**
 * A text note's drawn extent, estimated from its anchor and size: per
 * character, and per line, in font sizes. Generous on purpose — it only has to
 * hold the middle of the ink the note was read from.
 */
const TEXT_ADVANCE = 0.75;
const TEXT_LINE = 1.25;

interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

interface Footprint extends Box {
    kind: Annotation['kind'];
    /** Text notes only: font size (page widths) and length, for textBox(). */
    size?: number;
    chars?: number;
}

const footprintOf = (annotation: Annotation): Footprint | null => {
    const { payload } = annotation;
    if (isTextPayload(payload)) {
        return {
            kind: annotation.kind,
            x0: payload.x,
            y0: payload.y,
            x1: payload.x,
            y1: payload.y,
            size: payload.size,
            chars: Math.max(1, payload.text.length),
        };
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

/** Where a text note draws, given the page's width / height. */
const textBox = (note: Footprint, aspect: number): Box => {
    const size = note.size ?? 0;
    return {
        x0: note.x0,
        y0: note.y0,
        x1: note.x0 + (note.chars ?? 1) * size * TEXT_ADVANCE,
        y1: note.y0 + size * aspect * TEXT_LINE,
    };
};

const contains = (outer: Box, inner: Box, slack: number): boolean =>
    inner.x0 >= outer.x0 - slack &&
    inner.y0 >= outer.y0 - slack &&
    inner.x1 <= outer.x1 + slack &&
    inner.y1 <= outer.y1 + slack;

/** The ink a scanned item was read from, normalized; null for born-digital items (no clusters). */
const inkBoxOf = (page: PageProposal, item: ProposedItem): Box | null => {
    const { width, height, clusters } = page.segmentation;
    let box: Box | null = null;
    for (const id of item.clusterIds) {
        const cluster = clusters.find((c) => c.id === id);
        if (!cluster) {
            continue;
        }
        const { x, y, w, h } = cluster.bboxPx;
        const own = { x0: x / width, y0: y / height, x1: (x + w) / width, y1: (y + h) / height };
        box = box
            ? {
                  x0: Math.min(box.x0, own.x0),
                  y0: Math.min(box.y0, own.y0),
                  x1: Math.max(box.x1, own.x1),
                  y1: Math.max(box.y1, own.y1),
              }
            : own;
    }
    return box;
};

/**
 * Pool entries that show `item` was imported before as the other kind, or null.
 * Strokes matched by a text item are claimed, like an exact match. A text note
 * matched by ink is not: one note read from a run ("34323") stands for every
 * cluster of that run, which come back as ink one item each.
 */
const crossKindMatch = (item: ProposedItem, ink: Box, pool: Footprint[], aspect: number): number[] | null => {
    if (item.isText) {
        const inside = pool.flatMap((candidate, i) =>
            candidate.kind !== 'text' && contains(ink, candidate, INK_SLACK) ? [i] : [],
        );
        return inside.length > 0 ? inside : null;
    }
    const mx = (ink.x0 + ink.x1) / 2;
    const my = (ink.y0 + ink.y1) / 2;
    const mid = { x0: mx, y0: my, x1: mx, y1: my };
    return pool.some(
        (candidate) => candidate.kind === 'text' && contains(textBox(candidate, aspect), mid, MATCH_TOLERANCE),
    )
        ? []
        : null;
};

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
            const ink = matched ? null : inkBoxOf(page, item);
            const crossKind = ink ? crossKindMatch(item, ink, pool, page.rasterWidth / page.rasterHeight) : null;
            if (crossKind) {
                claimed.length = 0;
                claimed.push(...crossKind);
            }
            if (matched || crossKind) {
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
