import { isCloudDocId } from '@/features/library/documentsService';
import { AnnotationStore } from '@/sync/annotationStore';
import type { ScribblerDb } from '@/sync/db';
import { activeEngineFor, SyncEngine, type AnnotationsApi } from '@/sync/syncEngine';

/**
 * Sign-out support for the annotation outbox.
 *
 * Cloud-score annotations, their outbox and their day snapshots belong to the
 * account that wrote them, but Dexie is per browser: left behind, the next
 * account on a shared iPad would paint them, and its sync engine would push
 * the previous account's queued ops under its own JWT. Sign-out therefore
 * drains what it can and then clears them — after warning about anything that
 * could not be uploaded, since clearing it loses it for good.
 *
 * Local (`local-…`) scores are left alone: they live only on this device,
 * are never uploaded, and are not tied to an account, so clearing them would
 * be a loss with nothing to recover from.
 */

/** Outbox ops for cloud scores not yet accepted by the server. */
export const pendingCloudOpCount = (db: ScribblerDb): Promise<number> =>
    db.ops.filter((op) => isCloudDocId(op.docId)).count();

/**
 * Try to upload every cloud score's outbox before sign-out. Uses the open
 * viewer's engine for its document when there is one (so the same ops are
 * not pushed twice), and a short-lived headless engine for the rest. Gives up
 * after `timeoutMs` and returns how many ops are still pending.
 */
export const drainCloudOutboxes = async (deps: {
    db: ScribblerDb;
    api: AnnotationsApi;
    getUserId: () => string | null;
    timeoutMs: number;
}): Promise<number> => {
    const { db, api, getUserId, timeoutMs } = deps;
    const docIds = [...new Set((await db.ops.toArray()).map((op) => op.docId).filter(isCloudDocId))];
    const headless: SyncEngine[] = [];
    let timedOut = false;
    const work = (async () => {
        for (const docId of docIds) {
            if (timedOut) {
                return;
            }
            const active = activeEngineFor(docId);
            if (active) {
                await active.flush();
                continue;
            }
            const engine = new SyncEngine({ db, store: new AnnotationStore(db, docId), api, docId, getUserId });
            headless.push(engine);
            await engine.flush();
        }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            resolve();
        }, timeoutMs);
    });
    try {
        await Promise.race([work.catch((err: unknown) => console.warn('Sign-out sync failed', err)), timeout]);
    } finally {
        clearTimeout(timer);
        // Stopping cancels their retry timers and makes an in-flight flush
        // bail before writing again — the tables are about to be cleared.
        for (const engine of headless) {
            engine.stop();
        }
    }
    return pendingCloudOpCount(db);
};

/** Remove this account's cloud-score annotation data from the device. */
export const clearCloudAnnotationData = async (db: ScribblerDb): Promise<void> => {
    const isCloud = (row: { docId: string }) => isCloudDocId(row.docId);
    await db.transaction(
        'rw',
        [db.annotations, db.ops, db.syncState, db.annotationSnapshots, db.fingeringRegions],
        async () => {
            await db.annotations.filter(isCloud).delete();
            await db.ops.filter(isCloud).delete();
            await db.annotationSnapshots.filter(isCloud).delete();
            await db.fingeringRegions.filter(isCloud).delete();
            // Watermarks only exist for cloud scores; a stale one would make
            // the next account's first pull skip rows below it.
            await db.syncState.clear();
        },
    );
};
