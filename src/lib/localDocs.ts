/**
 * In-memory registry for PDFs opened from the local file system (no backend yet).
 * Document ids are content-addressed (sha-256) so the same file always maps to
 * the same id — which is what keeps annotations attached across re-opens.
 */

const registry = new Map<string, ArrayBuffer>();

export const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const localDocId = async (bytes: ArrayBuffer): Promise<string> => {
    const hash = await sha256Hex(bytes);
    return `local-${hash.slice(0, 16)}`;
};

export const putLocalDoc = (id: string, bytes: ArrayBuffer): void => {
    registry.set(id, bytes);
};

export const getLocalDoc = (id: string): ArrayBuffer | undefined => {
    return registry.get(id);
};
