/**
 * Cloud document ids are plain UUIDs; local-only docs use the 'local-' prefix.
 * A leaf module so the sync layer can ask without importing documentsService
 * (and everything behind it); documentsService re-exports it.
 */
export const isCloudDocId = (docId: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId);
};
