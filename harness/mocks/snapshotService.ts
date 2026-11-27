import type { LocalAnnotationSnapshot } from '../../src/features/viewer/history/snapshotTypes';

export * from '../../src/features/viewer/history/snapshotService';

const snap = (id: string, d: number, label: string | null, marks: number): LocalAnnotationSnapshot => ({
    id, docId: 'doc-fixture', capturedOn: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), label, payload: Array.from({ length: marks }, () => ({ deletedAt: null })) as unknown as LocalAnnotationSnapshot['payload'],
    createdAt: new Date(Date.now() - d * 86_400_000).toISOString(), createdBy: 'teacher', pending: 0,
});

export const listSnapshots = async (_docId: string) => [snap('s1', 0, null, 14), snap('s2', 7, null, 9), snap('s3', 14, null, 3)];
