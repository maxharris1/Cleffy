import { getDb } from '@/sync/db';

/**
 * Rewrites one student's count in the roster snapshot, so a later roster mount
 * paints the count an assignment change left rather than the one before it.
 * Best-effort, as the roster's own writes are.
 */
export const persistAssignmentCount = async (userId: string, studentUserId: string, count: number): Promise<void> => {
    const db = getDb();
    await db
        .transaction('rw', db.rosterCache, async () => {
            const cached = await db.rosterCache.get(userId);
            if (!cached) {
                return;
            }
            const assignmentCounts: Array<[string, number]> = [
                ...cached.assignmentCounts.filter(([id]) => id !== studentUserId),
                [studentUserId, count],
            ];
            await db.rosterCache.put({ ...cached, assignmentCounts });
        })
        .catch(() => undefined);
};
