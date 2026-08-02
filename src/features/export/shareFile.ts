/**
 * Offer a file via the Web Share API when the device supports file sharing
 * (Messages / AirDrop / Files on iOS), otherwise trigger a download.
 */
export const shareOrDownloadFile = async (file: File, title?: string): Promise<void> => {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: title ?? file.name });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                return;
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
};

export const safeFileBase = (title: string): string => title.replace(/[/\\:]/g, '-');
