import Dexie, { type Table } from 'dexie';

import type { RecognizedRegion } from '@/features/fingering/model';
import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { ScoreAnalysisStatus } from '@/types/database';
import type { Entitlements } from '@/types/database';
import type { Annotation } from '@/types/models';
import type { ScoreData } from '@/types/scoreData';

/** Server-mirror row: an Annotation plus a dirty flag for the op queue. */
export interface LocalAnnotation extends Annotation {
    /** 1 while a local op for this annotation has not been acked by the server. */
    pending: 0 | 1;
}

export type PendingOpType = 'create' | 'update' | 'delete' | 'restore';

/** Outbox entry, drained FIFO by the sync engine (M3+). */
export interface PendingOp {
    opId?: number;
    docId: string;
    type: PendingOpType;
    annotationId: string;
    /** Full row snapshot at enqueue time (server payload source). */
    annotation: Annotation;
    queuedAt: string;
}

export interface SyncState {
    docId: string;
    /** Highest server seq applied locally (pull watermark). */
    watermarkSeq: number;
}

/** Bytes as read back from Dexie: ArrayBuffer now, Blob in rows written before. */
export type CachedPdfBytes = Blob | ArrayBuffer;

/** Offline copy of a document's PDF bytes (M5). */
export interface CachedPdf {
    docId: string;
    /**
     * Written as an ArrayBuffer — WebKit cannot store a Blob in a private
     * browsing origin (see sync/pdfCache.ts). Blob stays in the union for
     * rows written by earlier builds; read via `readCachedPdfBytes`.
     */
    bytes: CachedPdfBytes;
    title: string;
    cachedAt: string;
    /** Last-known membership role — lets the viewer open offline with the right mode. */
    myRole?: 'owner' | 'editor' | 'viewer';
    /**
     * documents.content_rev these bytes correspond to. A smaller value than
     * the fetched row means the file was replaced (smart-import cleanup) —
     * re-download. Plain field, not indexed — no Dexie version bump needed.
     */
    contentRev?: number;
    /** Last-known archive state — archived scores are read-only (billing, M6). */
    archivedAt?: string | null;
}

/** Cached play-along analysis: offline replays and fast viewer opens (M-playback). */
export interface CachedScoreAnalysis {
    docId: string;
    status: ScoreAnalysisStatus;
    error: string | null;
    score: ScoreData | null;
    engineVersion: string | null;
    bpmDefault: number | null;
    /** Practice tempo the user chose for this score (survives reloads). */
    bpmOverride?: number;
    fetchedAt: string;
}

/** First-page render for the library row (local-only, never synced). */
export interface CachedThumbnail {
    docId: string;
    /** documents.content_rev the render came from — mismatch regenerates. */
    contentRev: number;
    /**
     * THUMB_MAX_SIDE this render was sized for. Rows written before the shelf
     * existed carry no value at all, so every reader must treat a missing one
     * as 0 (too small) rather than trusting the type — `undefined < 512` is
     * false, which would pin those 256px renders forever.
     */
    maxSide: number;
    blob: Blob; // image/png
    width: number;
    height: number;
    createdAt: string;
}

/**
 * Cached note-reading for one selected region (local-only, never synced).
 * Recognition is the expensive step — cache the POST-REVIEW region (user
 * corrections included) keyed by everything that could change the reading:
 * the rect, the PDF revision, and the annotations composited into the crop.
 */
export interface FingeringRegionCache {
    /** SHA-256 over docId | page | quantized rect | contentRev | annotationsHash. */
    id: string;
    docId: string;
    page: number;
    region: RecognizedRegion;
    createdAt: string;
}

/**
 * Last-known entitlements, so an offline start still knows the tier (M6).
 * Enforcement is always server-side; this only keeps the UI honest offline.
 */
export interface CachedEntitlements {
    userId: string;
    entitlements: Entitlements;
    cachedAt: string;
}

export class ScribblerDb extends Dexie {
    annotations!: Table<LocalAnnotation, string>;
    ops!: Table<PendingOp, number>;
    syncState!: Table<SyncState, string>;
    pdfCache!: Table<CachedPdf, string>;
    annotationSnapshots!: Table<LocalAnnotationSnapshot, string>;
    scoreCache!: Table<CachedScoreAnalysis, string>;
    fingeringRegions!: Table<FingeringRegionCache, string>;
    entitlements!: Table<CachedEntitlements, string>;
    thumbnails!: Table<CachedThumbnail, string>;

    constructor(name = 'scribbler') {
        super(name);
        this.version(1).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
        });
        this.version(2).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
        });
        this.version(3).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
            scoreCache: 'docId',
        });
        this.version(4).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
            scoreCache: 'docId',
            fingeringRegions: 'id, docId, createdAt',
        });
        // v5 unions the two schema lines that shipped separately: main's v3
        // created `entitlements`, while dev's v3 and v4 created `scoreCache`
        // and `fingeringRegions`. Dexie only replays versions ABOVE the one a
        // browser already sits on, so neither side would ever gain the other's
        // stores without a new version declaring the full set.
        this.version(5).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
            scoreCache: 'docId',
            fingeringRegions: 'id, docId, createdAt',
            entitlements: 'userId',
        });
        // Every store is restated, same as v5 — Dexie treats each version's
        // `stores()` as the complete schema for that version, so an omitted
        // table would be DROPPED on upgrade rather than carried forward.
        this.version(6).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
            scoreCache: 'docId',
            fingeringRegions: 'id, docId, createdAt',
            entitlements: 'userId',
            thumbnails: 'docId',
        });
    }
}

let instance: ScribblerDb | null = null;

/** App-wide database singleton (tests construct their own named instances). */
export const getDb = (): ScribblerDb => {
    if (!instance) {
        instance = new ScribblerDb();
    }
    return instance;
};
