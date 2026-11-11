import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';

/** The caller's storage use and cap (my_storage_usage, 20261022140600). */
export interface StorageUsage {
    usedBytes: number;
    limitBytes: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Bytes as the plans state them: 500 MB, 5 GB (binary units, as the caps are). */
export const formatStorageBytes = (bytes: number): string => {
    if (bytes >= GIB) {
        return `${Number((bytes / GIB).toFixed(1))} GB`;
    }
    if (bytes > 0 && bytes < MIB) {
        return 'less than 1 MB';
    }
    return `${Math.round(bytes / MIB)} MB`;
};

const isQuotaRefusal = (message: string): boolean => /storage_quota_exceeded/.test(message);

/**
 * What a refused upload says. Storage answers an upload that would take the
 * owner past their storage quota (20261022100800) with `storage_quota_exceeded`;
 * with the owner's figures (decision 50(3)) it says how full, against what cap.
 */
export const uploadFailureMessage = (message: string, usage: StorageUsage | null = null): string => {
    if (!isQuotaRefusal(message)) {
        return `Upload failed: ${message}`;
    }
    const figures = usage
        ? ` (${formatStorageBytes(usage.usedBytes)} of ${formatStorageBytes(usage.limitBytes)} used)`
        : '';
    return `Upload failed: your storage is full${figures}. Delete scores you no longer need (archived ones count too) or upgrade for more space.`;
};

/**
 * The signed-in owner's usage and cap, or null when it cannot be read: the
 * message then goes without numbers. Never throws.
 */
export const fetchStorageUsage = async (): Promise<StorageUsage | null> => {
    try {
        const { data, error } = await getSupabase().rpc('my_storage_usage');
        if (error || !data || typeof data.used_bytes !== 'number' || typeof data.limit_bytes !== 'number') {
            return null;
        }
        return { usedBytes: data.used_bytes, limitBytes: data.limit_bytes };
    } catch {
        return null;
    }
};

/** The refusal's message, with the owner's figures when it is the quota's. */
const failureFor = async (message: string): Promise<string> =>
    uploadFailureMessage(message, isQuotaRefusal(message) ? await fetchStorageUsage() : null);

/** Above this size, use the resumable (TUS) endpoint per Supabase guidance. */
const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024;

export interface UploadProgress {
    loaded: number;
    total: number;
}

/**
 * Upload a PDF into the private `scores` bucket. Small files go through the
 * standard endpoint; big scanned scores (IMSLP) use TUS so flaky rehearsal
 * wifi can resume instead of restarting a 50 MB PUT.
 */
export const uploadPdfToStorage = async (
    objectPath: string,
    file: File | Blob,
    onProgress?: (progress: UploadProgress) => void,
): Promise<void> => {
    const supabase = getSupabase();

    if (file.size <= TUS_THRESHOLD_BYTES) {
        const { error } = await supabase.storage
            .from('scores')
            .upload(objectPath, file, { contentType: 'application/pdf', upsert: true });
        if (error) {
            throw new Error(await failureFor(error.message));
        }
        onProgress?.({ loaded: file.size, total: file.size });
        return;
    }

    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }
    const { url: projectUrl } = requireSupabaseConfig();
    // Loaded here, on the first large upload: the resumable client and its
    // dependencies were 60 KB of the app's entry chunk, about a sixth of it,
    // downloaded and run before the first paint for a path most sessions
    // never take.
    const tus = await import('tus-js-client');

    await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
            endpoint: `${projectUrl}/storage/v1/upload/resumable`,
            retryDelays: [0, 1000, 3000, 5000, 10000],
            chunkSize: 6 * 1024 * 1024, // Supabase requires exactly 6MB chunks
            headers: { authorization: `Bearer ${accessToken}`, 'x-upsert': 'true' },
            metadata: {
                bucketName: 'scores',
                objectName: objectPath,
                contentType: 'application/pdf',
                cacheControl: '3600',
            },
            onProgress: (loaded, total) => onProgress?.({ loaded, total }),
            onSuccess: () => resolve(),
            onError: (err) => {
                if (isQuotaRefusal(err.message)) {
                    void failureFor(err.message).then((message) => reject(new Error(message)));
                } else {
                    reject(err);
                }
            },
        });
        // Resume a previous attempt of the same file when possible.
        void upload.findPreviousUploads().then((previous) => {
            const first = previous[0];
            if (first) {
                upload.resumeFromPreviousUpload(first);
            }
            upload.start();
        });
    });
};
