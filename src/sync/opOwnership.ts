import type { PendingOp, ScribblerDb } from '@/sync/db';
import { isCloudDocId } from '@/sync/docIds';
import { readCachedPdfMeta } from '@/sync/pdfCache';

/**
 * Which queued ops an account may treat as its own: upload under its name,
 * draw on its screen, warn about at its sign-out.
 *
 * Dexie is per browser, not per account, and a session can end without
 * sign-out clearing the outbox (an expired refresh token, a share-link guest
 * signing in to their own account), so the next account on the device can
 * find another one's queued changes. Uploading them would put them under the
 * wrong name, and a refusal would lose them. So an op is this account's when:
 *
 * - it is stamped with this account (PendingOp.userId); or
 * - it predates the stamp and the score's cached PDF is this account's — the
 *   test the offline open applies (loadDocumentOffline). Asked once per score
 *   and account, since it reads the cached PDF's bytes along with the row.
 *
 * Device-only (`local-…`) scores are never uploaded and belong to no account:
 * every op on them is the device's. On a cloud score with nobody signed in,
 * none is anyone's.
 */
export type OpOwner = (op: PendingOp) => boolean;

/** Answers for unstamped ops, by `${userId}\u0000${docId}`; see opOwnerFor. */
export type LegacyOwnerCache = Map<string, boolean>;

export const opOwnerFor = async (
    db: ScribblerDb,
    docId: string,
    userId: string | null,
    ops: readonly PendingOp[],
    cache?: LegacyOwnerCache,
): Promise<OpOwner> => {
    if (!isCloudDocId(docId)) {
        return () => true;
    }
    if (!userId) {
        return () => false;
    }
    let legacyOurs = false;
    if (ops.some((op) => op.userId === undefined)) {
        const key = `${userId}\u0000${docId}`;
        const known = cache?.get(key);
        if (known === undefined) {
            const cached = await readCachedPdfMeta(db, docId).catch(() => null);
            legacyOurs = cached?.userId === userId;
            cache?.set(key, legacyOurs);
        } else {
            legacyOurs = known;
        }
    }
    return (op) => (op.userId === undefined ? legacyOurs : op.userId === userId);
};

/**
 * Marks of a score with changes queued by an account other than `userId`.
 * Their mirror rows hold that account's unsynced version, so nothing this
 * account sees is drawn from them: not the viewer (AnnotationStore), not an
 * export.
 */
export const foreignMarkIds = async (db: ScribblerDb, docId: string, userId: string | null): Promise<Set<string>> => {
    const ops = await db.ops.where('docId').equals(docId).toArray();
    const owns = await opOwnerFor(db, docId, userId, ops);
    return new Set(ops.filter((op) => !owns(op)).map((op) => op.annotationId));
};
