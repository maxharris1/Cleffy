/**
 * How a file left the app. 'cancelled' is the share sheet dismissed: the file
 * was offered but not taken, which a metered export must not count as delivered.
 */
export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Offer a file via the Web Share API when the device supports file sharing
 * (Messages / AirDrop / Files on iOS), otherwise trigger a download.
 */
export const shareOrDownloadFile = async (file: File, title?: string): Promise<ShareOutcome> => {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: title ?? file.name });
            return 'shared';
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                return 'cancelled';
            }
            // Fall through to download on share failures.
        }
    }

    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
};

export const safeFileBase = (title: string): string => title.replace(/[/\\:]/g, '-');
