import { extractBornDigital } from '@/features/import/bornDigital';
import { openDetectionDoc, whiteFraction } from '@/features/import/pageRaster';
import { buildProposals } from '@/features/import/proposals';
import { segmentPage } from '@/features/import/segmentation';
import { vectorizeMask } from '@/features/import/vectorize';
import { sampleBackgroundColor } from '@/features/import/whiteout';
import type { DetectRequest, DetectResponse } from '@/features/import/detectWorker';
import type {
    ClassifyFn,
    ClassifyResult,
    DetectionRaster,
    ImportProposal,
    ImportStatus,
    PageProposal,
    PageSegmentation,
    ProposedItem,
} from '@/features/import/importTypes';
import type { StrokePayload } from '@/types/models';

/**
 * Whole-document scan, pipelined: pdf.js renders page N+1 on the main thread
 * while a worker segments/vectorizes page N; AI classification calls run
 * concurrently (bounded) as pages finish. Memory stays bounded — at most two
 * page rasters are alive for the pipeline plus the ones held briefly by
 * in-flight classification encodes.
 */

/** Concurrent AI classification calls — network-bound; rasters release after crop encoding. */
const CLASSIFY_CONCURRENCY = 2;

interface DetectResult {
    segmentation: PageSegmentation;
    vectors: Map<string, StrokePayload[]>;
    whiteFrac: number;
}

/** Main-thread fallback (jsdom, worker construction failure). Same math, same results. */
const detectInline = (raster: DetectionRaster, pageIndex: number): DetectResult => {
    const segmentation = segmentPage(raster, pageIndex);
    const vectors = new Map<string, StrokePayload[]>();
    for (const cluster of segmentation.clusters) {
        cluster.bgColorHex = sampleBackgroundColor(raster, cluster.mask);
        vectors.set(
            cluster.id,
            vectorizeMask(cluster.mask, cluster.area, cluster.thicknessPx, raster.width, raster.height),
        );
    }
    return { segmentation, vectors, whiteFrac: whiteFraction(raster) };
};

interface Detector {
    detect: (raster: DetectionRaster, pageIndex: number) => Promise<DetectResult>;
    destroy: () => void;
}

const createDetector = (): Detector => {
    if (typeof Worker === 'undefined') {
        return {
            detect: (raster, pageIndex) => Promise.resolve(detectInline(raster, pageIndex)),
            destroy: () => undefined,
        };
    }
    let worker: Worker | null = null;
    let broken = false;
    const detect = (raster: DetectionRaster, pageIndex: number): Promise<DetectResult> => {
        if (!broken && !worker) {
            try {
                worker = new Worker(new URL('./detectWorker.ts', import.meta.url), { type: 'module' });
            } catch {
                broken = true;
            }
        }
        const w = worker;
        if (broken || !w) {
            return Promise.resolve(detectInline(raster, pageIndex));
        }
        return new Promise<DetectResult>((resolve) => {
            const fallback = () => {
                broken = true;
                w.terminate();
                worker = null;
                resolve(detectInline(raster, pageIndex));
            };
            const done = (handler: () => void) => {
                w.removeEventListener('message', onMessage);
                w.removeEventListener('error', onError);
                handler();
            };
            const onMessage = (event: MessageEvent<DetectResponse>) => {
                done(() => {
                    const data = event.data;
                    if (!data.ok) {
                        fallback();
                        return;
                    }
                    resolve({
                        segmentation: data.segmentation,
                        vectors: new Map(data.vectors),
                        whiteFrac: data.whiteFrac,
                    });
                });
            };
            const onError = () => done(fallback);
            w.addEventListener('message', onMessage);
            w.addEventListener('error', onError);
            // Send a COPY — the original raster stays usable for classification
            // crops and for the inline fallback if the worker dies mid-page.
            const copy = raster.data.slice(0);
            const request: DetectRequest = {
                pageIndex,
                width: raster.width,
                height: raster.height,
                rgba: copy.buffer as ArrayBuffer,
            };
            w.postMessage(request, [copy.buffer as ArrayBuffer]);
        });
    };
    return {
        detect,
        destroy: () => {
            worker?.terminate();
            worker = null;
        },
    };
};

/** Bounded-concurrency runner. */
const semaphore = (limit: number) => {
    let active = 0;
    const queue: (() => void)[] = [];
    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= limit) {
            await new Promise<void>((wake) => queue.push(wake));
        }
        active++;
        try {
            return await fn();
        } finally {
            active--;
            queue.shift()?.();
        }
    };
};

type SettledLabels = { ok: ClassifyResult | null } | { err: unknown };

export const scanDocument = async (opts: {
    docId: string;
    bytes: ArrayBuffer;
    /** Null → strokes-only mode (no AI). */
    classify: ClassifyFn | null;
    /** Convert real PDF annotation objects too (off for local docs — no cleanup possible). */
    includeBornDigital: boolean;
    onStatus?: (status: ImportStatus) => void;
    signal?: AbortSignal;
}): Promise<ImportProposal> => {
    const { docId, bytes, classify, includeBornDigital, onStatus, signal } = opts;
    const doc = await openDetectionDoc(bytes);
    const detector = createDetector();
    try {
        const runClassify = semaphore(CLASSIFY_CONCURRENCY);
        const aborted = () => {
            if (signal?.aborted) {
                throw new DOMException('Scan cancelled', 'AbortError');
            }
        };

        interface PageEntry {
            pageIndex: number;
            det: DetectResult;
            born: { items: ProposedItem[]; stripSubtypes: string[] };
            labels: Promise<SettledLabels> | null;
        }
        const entries: PageEntry[] = [];

        interface Pending {
            pageIndex: number;
            raster: DetectionRaster;
            result: Promise<DetectResult>;
        }
        const settle = async (pending: Pending): Promise<void> => {
            const det = await pending.result;
            const born = includeBornDigital
                ? await extractBornDigital(await doc.getPageProxy(pending.pageIndex), pending.pageIndex, docId)
                : { items: [], stripSubtypes: [] };
            let labels: Promise<SettledLabels> | null = null;
            if (det.segmentation.clusters.length > 0 && classify) {
                onStatus?.({ kind: 'classifying', page: pending.pageIndex, pageCount: doc.numPages });
                const raster = pending.raster;
                // Wrap immediately so a rejection can't go unhandled while
                // later pages are still scanning; unwrapped at the end.
                labels = runClassify(() => classify(det.segmentation, raster, signal)).then(
                    (ok) => ({ ok }) as SettledLabels,
                    (err: unknown) => ({ err }) as SettledLabels,
                );
            }
            entries.push({ pageIndex: pending.pageIndex, det, born, labels });
        };

        let pending: Pending | null = null;
        for (let i = 0; i < doc.numPages; i++) {
            aborted();
            onStatus?.({ kind: 'scanning', page: i, pageCount: doc.numPages });
            const raster = await doc.renderPage(i);
            if (pending) {
                await settle(pending); // the worker crunched this page during the render above
            }
            pending = { pageIndex: i, raster, result: detector.detect(raster, i) };
        }
        if (pending) {
            await settle(pending);
        }

        const pages: PageProposal[] = [];
        const unreadablePages: number[] = [];
        const tooColorfulPages: number[] = [];
        let aiDegraded = false;
        for (const entry of entries) {
            aborted();
            const seg = entry.det.segmentation;
            if (seg.flags.tooColorful) {
                tooColorfulPages.push(entry.pageIndex);
            }
            let labels: ClassifyResult | null = null;
            if (entry.labels) {
                const settled = await entry.labels;
                if ('err' in settled) {
                    throw settled.err; // AbortError — classify returns null on ordinary failures
                }
                labels = settled.ok;
            }
            if (seg.clusters.length > 0 && !labels) {
                aiDegraded = true;
            }
            const items = [...entry.born.items, ...buildProposals(docId, seg, labels, entry.det.vectors)];
            if (items.length === 0 && seg.clusters.length === 0 && entry.det.whiteFrac >= 0.995) {
                unreadablePages.push(entry.pageIndex);
            }
            if (items.length > 0) {
                pages.push({
                    pageIndex: entry.pageIndex,
                    rasterWidth: seg.width,
                    rasterHeight: seg.height,
                    items,
                    segmentation: seg,
                    stripSubtypes: entry.born.stripSubtypes,
                });
            }
        }

        return { docId, pages, aiDegraded: pages.length > 0 && aiDegraded, unreadablePages, tooColorfulPages };
    } finally {
        detector.destroy();
        await doc.destroy();
    }
};
