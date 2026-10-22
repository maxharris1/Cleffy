import { getSupabase } from '@/lib/supabase';

/**
 * The published copy of a library cover.
 *
 * Edge Functions cannot render a PDF, so the browser that already rendered a
 * first page (on upload, on import, or because it holds the bytes) publishes
 * that render to the private `thumbnails` bucket at `{docId}/{rev}.jpg` and
 * records the revision on the row (documents.thumb_rev). Every other device
 * then downloads a ~40 KB image instead of the whole score.
 *
 * Storage RLS does the authorisation: only the owner may write under a
 * document's folder, so a member's attempt fails quietly and costs one
 * request per session; every member may read.
 */

const BUCKET = 'thumbnails';

export type PublishedThumbnail = { status: 'found'; blob: Blob } | { status: 'missing' } | { status: 'unavailable' };

type StorageErrorLike = {
    message?: string;
    statusCode?: string | number;
    status?: string | number;
};

const isMissingObject = (error: StorageErrorLike | null | undefined): boolean => {
    if (!error) {
        return false;
    }
    const code = error.statusCode ?? error.status;
    if (code === 404 || code === '404') {
        return true;
    }
    return /object not found/i.test(error.message ?? '');
};

export const thumbnailObjectPath = (docId: string, rev: number): string => `${docId}/${rev}.jpg`;

/**
 * One publish attempt per `docId:rev` per session, successful or not. A member
 * (or an offline owner) must not re-upload on every scroll, and a refused
 * upload on this device will be refused again the same way.
 */
const attempted = new Set<string>();

const attemptKey = (docId: string, rev: number): string => `${docId}:${rev}`;

/**
 * Whether a publish for this revision is still worth attempting this session.
 * `publishedRev` null = nothing published. `publishedMissing` is the 404
 * path: the row still names this revision but the object is gone, so the
 * same rev may be written again.
 */
export const shouldPublishThumbnail = (
    docId: string,
    rev: number,
    publishedRev: number | null,
    publishedMissing = false,
): boolean =>
    (publishedMissing || publishedRev === null || rev > publishedRev) && !attempted.has(attemptKey(docId, rev));

/** The published object is gone — allow this session to publish the same rev again. */
export const noteThumbnailObjectMissing = (docId: string, rev: number): void => {
    attempted.delete(attemptKey(docId, rev));
};

/**
 * The database's refusal of a third object in a score's thumbnail folder
 * (20261022100900): the published cover and one more is the most it holds.
 */
const isFolderFull = (error: StorageErrorLike | null | undefined): boolean =>
    /thumbnail_limit/.test(error?.message ?? '');

/** Upload the render and stamp the row. Resolves to whether both landed. */
export const publishThumbnail = async (docId: string, rev: number, blob: Blob): Promise<boolean> => {
    const key = attemptKey(docId, rev);
    if (attempted.has(key)) {
        return false;
    }
    attempted.add(key);
    try {
        const supabase = getSupabase();
        const upload = () =>
            supabase.storage
                .from(BUCKET)
                .upload(thumbnailObjectPath(docId, rev), blob, { contentType: 'image/jpeg', upsert: true });
        let { error } = await upload();
        if (isFolderFull(error)) {
            // Besides the published cover, the folder holds an upload whose
            // publish never landed, or a cover a newer one replaced that no
            // purge has reached. Neither is current, so they are this
            // revision's to replace: remove them and try once more.
            await removeClaimedThumbnails([docId], rev);
            ({ error } = await upload());
        }
        if (error) {
            return false;
        }
        const { error: rowError } = await supabase.from('documents').update({ thumb_rev: rev }).eq('id', docId);
        if (rowError) {
            return false;
        }
        void purgeSupersededThumbnails({ docId });
        return true;
    } catch {
        return false;
    }
};

/** Scores whose superseded covers one library sweep purges. */
const PURGE_BATCH = 100;

/**
 * Remove the covers the database lets this owner remove now. It claims them
 * under the score's lock (claim_superseded_thumbnails, 20261022100900): with
 * `writingRev`, everything in the folder but the published revision and the
 * one about to be written; without, the covers a newer revision replaced. A
 * claimed cover can no longer be published, so a removal never takes the
 * score's current cover, whatever another device does meanwhile. Never
 * throws: what is left is claimed again on the next library visit.
 */
const removeClaimedThumbnails = async (docIds: string[], writingRev?: number): Promise<void> => {
    try {
        const supabase = getSupabase();
        const { data: names, error } = await supabase.rpc(
            'claim_superseded_thumbnails',
            writingRev === undefined
                ? { p_document_ids: docIds }
                : { p_document_ids: docIds, p_writing_rev: writingRev },
        );
        if (error || !names || names.length === 0) {
            return;
        }
        await supabase.storage.from(BUCKET).remove(names);
    } catch {
        // The next library visit tries again.
    }
};

/**
 * Remove covers a newer revision has replaced, for one score or across an
 * owner's library. The database lists them in thumbnail_storage_cleanup
 * (20261022100800) and drops each row as its object goes; until they are
 * gone, the folder takes no newer cover than the one replacing the latest.
 * Never throws: what is left is retried on the next library visit
 * (sweepPendingStorageCleanup).
 */
export const purgeSupersededThumbnails = async (target: { docId: string } | { ownerId: string }): Promise<void> => {
    try {
        if ('docId' in target) {
            await removeClaimedThumbnails([target.docId]);
            return;
        }
        const { data: rows, error } = await getSupabase()
            .from('thumbnail_storage_cleanup')
            .select('document_id')
            .eq('owner_id', target.ownerId)
            .order('superseded_at', { ascending: true })
            .limit(PURGE_BATCH);
        if (error || !rows || rows.length === 0) {
            return;
        }
        await removeClaimedThumbnails([...new Set(rows.map((row) => row.document_id))]);
    } catch {
        // The next library visit tries again.
    }
};

/**
 * Downloads run a few at a time. A shelf of a hundred cards mounting at once
 * must not open a hundred connections — and on a phone the visible dozen are
 * the ones that matter, so the queue is FIFO in mount order.
 */
const MAX_CONCURRENT_DOWNLOADS = 4;
let active = 0;
const waiting: Array<() => void> = [];

const acquire = (): Promise<void> =>
    new Promise((resolve) => {
        if (active < MAX_CONCURRENT_DOWNLOADS) {
            active += 1;
            resolve();
            return;
        }
        waiting.push(() => {
            active += 1;
            resolve();
        });
    });

/** Callers waiting for the download queue to go quiet (coverDownloadsSettled). */
let settledWaiters: Array<() => void> = [];

const release = (): void => {
    active -= 1;
    waiting.shift()?.();
    if (active === 0 && waiting.length === 0 && settledWaiters.length > 0) {
        const done = settledWaiters;
        settledWaiters = [];
        done.forEach((resolve) => resolve());
    }
};

/**
 * Resolves once no cover is downloading or queued — at once if none is. For
 * work that should not share the connection with the first screen of covers
 * (see LibraryPage's viewer prefetch).
 */
export const coverDownloadsSettled = (): Promise<void> =>
    active === 0 && waiting.length === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
              settledWaiters.push(resolve);
          });

/** The published cover at this revision: found, 404-missing, or otherwise unavailable. */
export const fetchPublishedThumbnail = async (docId: string, rev: number): Promise<PublishedThumbnail> => {
    await acquire();
    try {
        const { data, error } = await getSupabase().storage.from(BUCKET).download(thumbnailObjectPath(docId, rev));
        if (data && !error) {
            return { status: 'found', blob: data };
        }
        if (isMissingObject(error)) {
            return { status: 'missing' };
        }
        return { status: 'unavailable' };
    } catch {
        return { status: 'unavailable' };
    } finally {
        release();
    }
};

/** HTTP status of a refused exists() probe: on the error, or on the response it wraps. */
const probeStatusOf = (error: unknown): number | undefined => {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const { status, originalError } = error as { status?: unknown; originalError?: { status?: unknown } };
    const code = typeof status === 'number' ? status : originalError?.status;
    return typeof code === 'number' ? code : undefined;
};

/**
 * Probes run one at a time, on a lane of their own: they only guard against a
 * rare missing object, and must never hold up a download a card is waiting on.
 */
let probeLane: Promise<unknown> = Promise.resolve();

/**
 * Whether the published cover at this revision is still in the bucket. A HEAD
 * request: confirming a cover this device already holds used to download the
 * whole image again, for every cover on screen, on every launch.
 */
export const probePublishedThumbnail = (docId: string, rev: number): Promise<PublishedThumbnail['status']> => {
    const probe = probeLane.then(async (): Promise<PublishedThumbnail['status']> => {
        try {
            const { data, error } = await getSupabase().storage.from(BUCKET).exists(thumbnailObjectPath(docId, rev));
            if (data) {
                return 'found';
            }
            // exists() answers false for a 400 as well as a 404, and Storage
            // answers some auth and JWT failures with a 400 that a HEAD has no
            // body to explain: only a 404 is "missing" (a republish). Anything
            // it throws on (a 503, a dropped connection) is not either.
            return probeStatusOf(error) === 404 ? 'missing' : 'unavailable';
        } catch {
            return 'unavailable';
        }
    });
    probeLane = probe.catch(() => undefined);
    return probe;
};
