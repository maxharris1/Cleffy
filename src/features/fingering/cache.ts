import type { NormRect, RecognizedRegion } from '@/features/fingering/model';
import { inflateRect } from '@/features/fingering/selection';
import { annotationBboxNorm } from '@/features/viewer/ink/hitTest';
import type { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';
import type { ScoreData } from '@/types/scoreData';

/**
 * Local cache of note readings so re-opening a diagram is instant and free.
 * The key hashes everything that could change the reading: the rect (3dp —
 * marquee jitter below a millinorm shouldn't miss), the PDF revision, and
 * the (id, updatedAt) set of annotations near the region, since those are
 * composited into the crop the model saw. What's stored is the POST-REVIEW
 * region, so user corrections persist too. Local-only — never synced.
 */

/** Match the crop margin so any annotation that was visible participates. */
const KEY_MARGIN = 0.03;
/** Global row cap; oldest pruned on write. */
const MAX_ROWS = 300;

export interface RegionCacheKeyInput {
    docId: string;
    page: number;
    rect: NormRect;
    /** documents.content_rev (0 for local docs — bytes are content-addressed). */
    contentRev: number;
    /** Committed annotations on the page (filtered to the region here). */
    annotations: readonly Annotation[];
    /** Page width/height ratio, for annotation bbox math. */
    aspect: number;
    /**
     * Play-along identity so a regenerated analysis invalidates OMR readings.
     * Prefer {@link scoreCacheEpoch} from the same ScoreData instance used for
     * mapping — never a separate Dexie dig that can desync from the `score` prop.
     */
    scoreEpoch: string;
}

/** Stable-enough identity for a ScoreData payload (invalidates on re-analysis). */
export const scoreCacheEpoch = (score: ScoreData | null | undefined): string => {
    if (!score) {
        return '';
    }
    // Include geometry + warnings so a re-run that only fixes positions /
    // measure_geometry_mismatch still invalidates cached OMR readings.
    const measures = score.measures
        .map((m) => {
            const slots = (m.sl ?? []).map((s) => `${s.x.toFixed(4)}:${s.t}`).join('/');
            return `${m.n}:${m.tick}:${m.page}:${m.sys}:${m.x0.toFixed(4)}:${m.x1.toFixed(4)}:${slots}`;
        })
        .join(',');
    const systems = score.systems
        .map(
            (s) =>
                `${s.page}:${s.y0.toFixed(4)}:${s.y1.toFixed(4)}:${(s.staves ?? []).map((b) => `${b.y0.toFixed(4)}-${b.y1.toFixed(4)}`).join('/')}`,
        )
        .join(',');
    const notes = score.notes.map((n) => `${n.t}:${n.p}:${n.h}`).join(',');
    return [
        score.version,
        score.totalTicks,
        score.warnings.join(','),
        score.keySignatures?.map((k) => `${k.tick}:${k.fifths}`).join(',') ?? '',
        score.clefs?.map((c) => `${c.tick}:${c.staff}:${c.sign}:${c.line ?? ''}`).join(',') ?? '',
        measures,
        systems,
        notes,
    ].join('|');
};

export const regionCacheKey = async (input: RegionCacheKeyInput): Promise<string> => {
    const searchRect = inflateRect(input.rect, KEY_MARGIN, KEY_MARGIN);
    const nearby = input.annotations
        .filter((a) => {
            const [minX, minY, maxX, maxY] = annotationBboxNorm(a, input.aspect);
            return (
                minX <= searchRect.x + searchRect.w &&
                maxX >= searchRect.x &&
                minY <= searchRect.y + searchRect.h &&
                maxY >= searchRect.y
            );
        })
        .map((a) => `${a.id}:${a.updatedAt}`)
        .sort()
        .join(',');
    const quantized = [input.rect.x, input.rect.y, input.rect.w, input.rect.h]
        .map((v) => v.toFixed(3))
        .join(',');
    const material = `${input.docId}|${input.page}|${quantized}|${input.contentRev}|${nearby}|${input.scoreEpoch}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const readCachedRegion = async (db: ScribblerDb, key: string): Promise<RecognizedRegion | null> => {
    const row = await db.fingeringRegions.get(key);
    return row?.region ?? null;
};

export const writeCachedRegion = async (
    db: ScribblerDb,
    key: string,
    region: RecognizedRegion,
): Promise<void> => {
    await db.fingeringRegions.put({
        id: key,
        docId: region.docId,
        page: region.page,
        region,
        createdAt: new Date().toISOString(),
    });
    const count = await db.fingeringRegions.count();
    if (count > MAX_ROWS) {
        const stale = await db.fingeringRegions.orderBy('createdAt').limit(count - MAX_ROWS).primaryKeys();
        await db.fingeringRegions.bulkDelete(stale);
    }
};
