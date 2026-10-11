import { isCloudDocId } from '@/features/library/documentsService';
import { AnnotationStore } from '@/sync/annotationStore';
import type { PendingOp, ScribblerDb } from '@/sync/db';
import { opOwnerFor } from '@/sync/opOwnership';
import { activeEngineFor, observeRejections, SyncEngine, type AnnotationsApi } from '@/sync/syncEngine';

/**
 * Sign-out support for the annotation outbox.
 *
 * Cloud-score annotations, their outbox and their day snapshots belong to the
 * account that wrote them, but Dexie is per browser: left behind, the next
 * account on a shared iPad would paint them, and its sync engine would push
 * the previous account's queued ops under its own JWT. Sign-out therefore
 * drains what it can and then clears them — after warning about anything that
 * could not be uploaded, since clearing it loses it for good. (A session can
 * also end without sign-out; the next account then neither draws nor sends
 * the ops it finds — see opOwnerFor — until its own sign-out clears them.)
 *
 * Local (`local-…`) scores are left alone: they live only on this device,
 * are never uploaded, and are not tied to an account, so clearing them would
 * be a loss with nothing to recover from.
 */

/** Outbox ops for cloud scores not yet accepted by the server. */
export const pendingCloudOpCount = (db: ScribblerDb): Promise<number> =>
    db.ops.filter((op) => isCloudDocId(op.docId)).count();

export interface DrainResult {
    /** Outbox ops for cloud scores still not accepted by the server. */
    pending: number;
    /**
     * Distinct marks whose change the server refused for good during the
     * drain (lost edit access, invalid mark). Those ops are gone and the marks
     * rolled back to the server's version — the user must still be told.
     */
    refused: number;
    /**
     * How many of the `pending` ops are not this account's (see opOwnerFor):
     * queued here by another account whose session ended without signing out.
     * Never uploaded under this account's name, so sign-out can only clear
     * them — and says so, rather than calling them this account's changes.
     */
    foreign: number;
}

/** Outbox ops for cloud scores that are not `userId`'s (see DrainResult.foreign). */
export const foreignCloudOpCount = async (db: ScribblerDb, userId: string): Promise<number> => {
    const byDoc = new Map<string, PendingOp[]>();
    for (const op of await db.ops.toArray()) {
        if (isCloudDocId(op.docId)) {
            byDoc.set(op.docId, [...(byDoc.get(op.docId) ?? []), op]);
        }
    }
    let foreign = 0;
    for (const [docId, ops] of byDoc) {
        const owns = await opOwnerFor(db, docId, userId, ops);
        foreign += ops.filter((op) => !owns(op)).length;
    }
    return foreign;
};

/**
 * Try to upload every cloud score's outbox before sign-out. Uses the open
 * viewer's engine for its document when there is one (so the same ops are
 * not pushed twice), and a short-lived headless engine for the rest. Either
 * sends only the signed-in account's ops: another account's are counted in
 * `foreign`, never uploaded under this one's name. Gives up after
 * `timeoutMs` and returns how many ops are still pending, and how many marks
 * the server refused along the way.
 */
export const drainCloudOutboxes = async (deps: {
    db: ScribblerDb;
    api: AnnotationsApi;
    getUserId: () => string | null;
    timeoutMs: number;
}): Promise<DrainResult> => {
    const { db, api, getUserId, timeoutMs } = deps;
    const docIds = [...new Set((await db.ops.toArray()).map((op) => op.docId).filter(isCloudDocId))];
    // Observed across engines rather than via onRejected, so a refusal that
    // lands in the open viewer's engine during the drain counts too.
    const refused = new Set<string>();
    const stopObserving = observeRejections((rejection) => {
        if (docIds.includes(rejection.docId)) {
            refused.add(`${rejection.docId}:${rejection.annotationId}`);
        }
    });
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
            const store = new AnnotationStore(db, docId);
            store.setAuthor(getUserId());
            const engine = new SyncEngine({ db, store, api, docId, getUserId });
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
        stopObserving();
        // Stopping cancels their retry timers and makes an in-flight flush
        // bail before writing again — the tables are about to be cleared.
        for (const engine of headless) {
            engine.stop();
        }
    }
    const userId = getUserId();
    return {
        pending: await pendingCloudOpCount(db),
        refused: refused.size,
        foreign: userId ? await foreignCloudOpCount(db, userId) : 0,
    };
};

/**
 * Make sure every cloud-score op `userId` owns says so on the op itself, and
 * count them. For a sign-out that keeps the outbox (session.ts
 * signOutKeepingChanges) but clears the cached PDFs: ops queued before
 * PendingOp.userId existed are this account's only through the cached PDF's
 * userId (opOwnerFor), and would belong to nobody once it is gone.
 */
export const stampOwnCloudOps = async (db: ScribblerDb, userId: string): Promise<number> => {
    const byDoc = new Map<string, PendingOp[]>();
    for (const op of await db.ops.toArray()) {
        if (isCloudDocId(op.docId)) {
            byDoc.set(op.docId, [...(byDoc.get(op.docId) ?? []), op]);
        }
    }
    let own = 0;
    for (const [docId, ops] of byDoc) {
        const owns = await opOwnerFor(db, docId, userId, ops);
        const mine = ops.filter(owns);
        own += mine.length;
        const legacy = mine.filter((op) => op.userId === undefined && op.opId !== undefined);
        if (legacy.length > 0) {
            await db.ops.bulkUpdate(legacy.map((op) => ({ key: op.opId as number, changes: { userId } })));
        }
    }
    return own;
};

/**
 * Delete every cloud-score op `userId` owns, and count them. For an account
 * that no longer exists (session.ts signOutDeletedAccount): nothing can ever
 * upload them, but another account's kept ops on the same device are still
 * waiting for that account's next sign-in, so only these go.
 */
export const dropOwnCloudOps = async (db: ScribblerDb, userId: string): Promise<number> => {
    // Stamped first, so a legacy op that is this account's only through the
    // cached PDF (opOwnerFor) is matched below as well.
    await stampOwnCloudOps(db, userId);
    return db.ops.filter((op) => isCloudDocId(op.docId) && op.userId === userId).delete();
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
