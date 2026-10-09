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

export type PublishedThumbnail =
    | { status: 'found'; blob: Blob }
    | { status: 'missing' }
    | { status: 'unavailable' };

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

/** Upload the render and stamp the row. Resolves to whether both landed. */
export const publishThumbnail = async (docId: string, rev: number, blob: Blob): Promise<boolean> => {
    const key = attemptKey(docId, rev);
    if (attempted.has(key)) {
        return false;
    }
    attempted.add(key);
    try {
        const supabase = getSupabase();
        const { error } = await supabase.storage
            .from(BUCKET)
            .upload(thumbnailObjectPath(docId, rev), blob, { contentType: 'image/jpeg', upsert: true });
        if (error) {
            return false;
        }
        const { error: rowError } = await supabase.from('documents').update({ thumb_rev: rev }).eq('id', docId);
        return !rowError;
    } catch {
        return false;
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

const release = (): void => {
    active -= 1;
    waiting.shift()?.();
};

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
