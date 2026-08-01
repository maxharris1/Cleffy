import * as tus from 'tus-js-client';

import { getSupabase } from '@/lib/supabase';

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
            throw new Error(`Upload failed: ${error.message}`);
        }
        onProgress?.({ loaded: file.size, total: file.size });
        return;
    }

    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }
    const projectUrl = import.meta.env.VITE_SUPABASE_URL as string;

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
            onError: (err) => reject(err),
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
