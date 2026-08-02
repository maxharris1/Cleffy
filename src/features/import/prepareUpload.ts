import { imageFileToPdf } from '@/features/import/imageToPdf';
import { MAX_UPLOAD_BYTES, sniffFile } from '@/features/import/sniffFile';

/** What the file input advertises; sniffing is what actually decides. */
export const UPLOAD_ACCEPT =
    'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic';

export interface PreparedUpload {
    /** Always a PDF; keeps the original base name with a .pdf extension. */
    file: File;
    /** True when the source was an image wrapped into a PDF page. */
    convertedFromImage: boolean;
}

const stripExtension = (name: string): string => name.replace(/\.(pdf|png|jpe?g|webp|heic|heif)$/i, '');

const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Validate and normalize any picked file into the PDF the rest of the app
 * (storage bucket, viewer, export, detection) expects. Throws user-facing
 * messages — callers surface them verbatim.
 */
export const prepareUploadFile = async (file: File): Promise<PreparedUpload> => {
    if (file.size === 0) {
        throw new Error('That file is empty.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`That file is ${formatMb(file.size)} — the limit is 50 MB.`);
    }
    const kind = await sniffFile(file);
    if (kind === 'pdf') {
        return { file, convertedFromImage: false };
    }
    if (kind === null) {
        throw new Error('Unsupported file type — upload a PDF or an image (PNG, JPEG, WebP).');
    }
    const pdfBytes = await imageFileToPdf(file, kind);
    if (pdfBytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error('The converted PDF exceeds the 50 MB limit — try a smaller image.');
    }
    const base = stripExtension(file.name).trim() || 'Photo score';
    return {
        file: new File([pdfBytes as BlobPart], `${base}.pdf`, { type: 'application/pdf' }),
        convertedFromImage: true,
    };
};
