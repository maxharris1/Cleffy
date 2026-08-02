import { z } from 'zod';

import { encodeCropJpeg, encodePageJpeg } from '@/features/import/pageRaster';
import { getSupabase } from '@/lib/supabase';
import type { ClassifyFn, ClassifyResult } from '@/features/import/importTypes';

/**
 * Client for the analyze-annotations edge function. Raw fetch (imslpApi
 * precedent) so structured error bodies are readable. EVERY failure — auth,
 * rate limit, AI down, malformed response — resolves to null: the pipeline
 * degrades to strokes-only import and the review UI offers a retry.
 */

const classifyResponseSchema = z.object({
    ok: z.literal(true),
    page: z.number(),
    clusters: z.array(
        z.object({
            id: z.string(),
            kind: z.enum(['digit', 'text', 'articulation', 'mark', 'noise']),
            text: z.string().optional(),
            confidence: z.enum(['high', 'medium', 'low']),
        }),
    ),
    runs: z.array(
        z.object({
            id: z.string(),
            treatAsOneText: z.boolean(),
            text: z.string().optional(),
        }),
    ),
});

/** Mirrors the edge function's cap; larger pages send the biggest clusters only. */
export const MAX_CLUSTERS_PER_CALL = 60;

/** Build the per-page ClassifyFn for a cloud document the caller owns. */
export const makeCloudClassifyFn = (docId: string): ClassifyFn => {
    return async (seg, raster, signal): Promise<ClassifyResult | null> => {
        try {
            const supabase = getSupabase();
            const { data: sessionData } = await supabase.auth.getSession();
            const accessToken = sessionData.session?.access_token;
            if (!accessToken) {
                return null;
            }

            const chosen = [...seg.clusters].sort((a, b) => b.area - a.area).slice(0, MAX_CLUSTERS_PER_CALL);
            const pageImage = await encodePageJpeg(raster);
            const clusters = [];
            for (const cluster of chosen) {
                clusters.push({
                    id: cluster.id,
                    bbox: [
                        cluster.bboxPx.x / seg.width,
                        cluster.bboxPx.y / seg.height,
                        cluster.bboxPx.w / seg.width,
                        cluster.bboxPx.h / seg.height,
                    ] as [number, number, number, number],
                    colorHex: cluster.meanColorHex,
                    runId: cluster.runId ?? undefined,
                    crop: await encodeCropJpeg(raster, cluster.bboxPx),
                });
            }
            const chosenIds = new Set(chosen.map((c) => c.id));
            const runsById = new Map<string, string[]>();
            for (const cluster of chosen) {
                if (cluster.runId) {
                    const list = runsById.get(cluster.runId) ?? [];
                    list.push(cluster.id);
                    runsById.set(cluster.runId, list);
                }
            }
            const runs = [...runsById.entries()]
                .filter(([, ids]) => ids.every((id) => chosenIds.has(id)))
                .map(([id, clusterIds]) => ({ id, clusterIds }));

            const projectUrl = import.meta.env.VITE_SUPABASE_URL as string;
            const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
            const response = await fetch(`${projectUrl}/functions/v1/analyze-annotations`, {
                method: 'POST',
                signal,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    apikey: anonKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    documentId: docId,
                    page: seg.pageIndex,
                    pageImage,
                    clusters,
                    runs,
                }),
            });
            if (!response.ok) {
                return null;
            }
            const parsed = classifyResponseSchema.safeParse(await response.json());
            if (!parsed.success) {
                console.warn('Ignoring malformed analyze response', parsed.error.issues[0]?.message);
                return null;
            }
            return { clusters: parsed.data.clusters, runs: parsed.data.runs };
        } catch (err) {
            // A cancelled scan must abort, not silently degrade.
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw err;
            }
            console.warn('Annotation recognition unavailable', err);
            return null;
        }
    };
};
