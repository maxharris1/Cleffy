/** Upload kinds the app can normalize into a PDF (sniffed, never trusted from extension/MIME). */
export type SniffedFileKind = 'pdf' | 'png' | 'jpeg' | 'webp' | 'heic';

/** Matches the `scores` bucket cap (SETUP_SUPABASE.md) so failures happen before any network. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Bytes needed to identify every supported container. */
export const SNIFF_HEADER_BYTES = 16;

const matches = (header: Uint8Array, signature: readonly number[], offset = 0): boolean =>
    signature.every((byte, i) => header[offset + i] === byte);

/** ISO-BMFF major brands that decode as HEIC/HEIF stills. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1']);

/**
 * Identify a file by magic bytes. Extensions and File.type lie (the cloud
 * upload path even hard-codes application/pdf), so this is the only
 * client-side check that means anything.
 */
export const sniffFileKind = (header: Uint8Array): SniffedFileKind | null => {
    if (matches(header, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
        return 'pdf'; // %PDF-
    }
    if (matches(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'png';
    }
    if (matches(header, [0xff, 0xd8, 0xff])) {
        return 'jpeg';
    }
    if (matches(header, [0x52, 0x49, 0x46, 0x46]) && matches(header, [0x57, 0x45, 0x42, 0x50], 8)) {
        return 'webp'; // RIFF….WEBP
    }
    if (matches(header, [0x66, 0x74, 0x79, 0x70], 4)) {
        // ISO-BMFF: box size (4 bytes) + 'ftyp' + major brand.
        const brand = String.fromCharCode(header[8] ?? 0, header[9] ?? 0, header[10] ?? 0, header[11] ?? 0);
        if (HEIC_BRANDS.has(brand)) {
            return 'heic';
        }
    }
    return null;
};

/** Sniff a File/Blob without reading more than the header. */
export const sniffFile = async (file: Blob): Promise<SniffedFileKind | null> => {
    const head = new Uint8Array(await file.slice(0, SNIFF_HEADER_BYTES).arrayBuffer());
    return sniffFileKind(head);
};
