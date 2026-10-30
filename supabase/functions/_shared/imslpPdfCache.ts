/** Shared originals only. No user data enters this cache. Side effects are injected for tests. */
export const IMSLP_CACHE_PREFIX = '00000000-0000-0000-0000-000000000000/';
export const isSharedImslpPath = (path: string): boolean =>
    /^00000000-0000-0000-0000-000000000000\/[a-f0-9]{64}\.pdf$/.test(path);

/** IMSLP embeds its stable file/edition number in normal PDF filenames. */
export const imslpFileId = (canonicalFilename: string): string => {
    const id = /^IMSLP(\d+)[ -]/i.exec(canonicalFilename)?.[1];
    // Older filenames without the numeric prefix remain usable and share by canonical filename.
    return id ? String(BigInt(id)) : `filename:${canonicalFilename}`;
};

export interface SharedPdfEntry {
    imslp_file_id: string;
    filename: string;
    storage_path: string;
    sha256: string;
    size: number;
    fetched_at: string;
    blocked_at?: string | null;
    work_title: string;
    license_label: string | null;
    provenance: {
        source_url: string;
        source_filename: string;
        source_license: string | null;
        source_attribution: {
            source: 'imslp';
            work: string;
            composer: string | null;
            editor: string | null;
            arranger: string | null;
            publisher: string | null;
            year: number | null;
        };
    };
}

export type SharedPdfMetadata = Pick<SharedPdfEntry, 'work_title' | 'license_label' | 'provenance'>;

export interface PdfCacheDeps {
    read(fileId: string): Promise<SharedPdfEntry | null>;
    claim(fileId: string, token: string): Promise<boolean>;
    release(fileId: string, token: string): Promise<void>;
    /** Immutable create; an existing hash object must be verified, never overwritten. */
    upload(path: string, bytes: Uint8Array): Promise<void>;
    /** Must fence on the claim token and confirm Storage completed before publishing. */
    publish(entry: SharedPdfEntry, token: string): Promise<void>;
}

export interface PdfCacheSession {
    entry: SharedPdfEntry | null;
    store(bytes: Uint8Array, metadata: SharedPdfMetadata): Promise<SharedPdfEntry>;
}

export const pdfSha256 = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

export class SharedPdfBlockedError extends Error {}
export class SharedPdfValidationError extends Error {}

export const validateSharedPdf = (bytes: Uint8Array): void => {
    const head = new TextDecoder().decode(bytes.subarray(0, 8));
    const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
    if (bytes.length > 50 * 1024 * 1024 || !/^%PDF-\d\.\d/.test(head) || !tail.includes('%%EOF')) {
        throw new SharedPdfValidationError('IMSLP did not deliver a complete PDF within the size limit');
    }
};

/** A loser queues via the existing client retry contract; it never downloads a duplicate. */
export const withImslpPdfCache = async <T>(
    filename: string,
    deps: PdfCacheDeps,
    run: (session: PdfCacheSession) => Promise<T>,
    busy: () => T,
): Promise<T> => {
    const fileId = imslpFileId(filename);
    let entry = await deps.read(fileId);
    const token = crypto.randomUUID();
    let claimed = false;
    if (!entry) {
        claimed = await deps.claim(fileId, token);
    }
    try {
        if (!entry) {
            // Another producer may have finished between read and claim.
            entry = await deps.read(fileId);
            if (!claimed && !entry) {
                return busy();
            }
        }
        if (entry?.blocked_at) {
            throw new SharedPdfBlockedError('This edition is unavailable for import');
        }
        const session: PdfCacheSession = {
            entry,
            store: async (bytes, metadata) => {
                if (session.entry) {
                    return session.entry;
                }
                if (!claimed) {
                    throw new Error('Shared PDF cache claim is required');
                }
                validateSharedPdf(bytes);
                const sha256 = await pdfSha256(bytes);
                const ready: SharedPdfEntry = {
                    ...metadata,
                    imslp_file_id: fileId,
                    filename,
                    storage_path: `${IMSLP_CACHE_PREFIX}${sha256}.pdf`,
                    sha256,
                    size: bytes.byteLength,
                    fetched_at: new Date().toISOString(),
                };
                await deps.upload(ready.storage_path, bytes);
                await deps.publish(ready, token);
                session.entry = ready;
                return ready;
            },
        };
        return await run(session);
    } finally {
        if (claimed) {
            // A crash is recovered by lease expiry; a failed release must not hide a delivered score.
            await deps.release(fileId, token).catch(() => undefined);
        }
    }
};
