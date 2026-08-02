import Dexie, { type Table } from 'dexie';

import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { Annotation } from '@/types/models';

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

/** Offline copy of a document's PDF bytes (M5). */
export interface CachedPdf {
    docId: string;
    bytes: Blob;
    title: string;
    cachedAt: string;
    /** Last-known membership role — lets the viewer open offline with the right mode. */
    myRole?: 'owner' | 'editor' | 'viewer';
}

export class ScribblerDb extends Dexie {
    annotations!: Table<LocalAnnotation, string>;
    ops!: Table<PendingOp, number>;
    syncState!: Table<SyncState, string>;
    pdfCache!: Table<CachedPdf, string>;
    annotationSnapshots!: Table<LocalAnnotationSnapshot, string>;

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
