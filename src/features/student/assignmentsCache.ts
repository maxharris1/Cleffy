import type { AssignedScore } from '@/features/student/studentApi';
import { z } from '@/lib/zod';

/**
 * What the assignments page reads off each cached score before the network
 * answers. Checked, not trusted: the row was written by an earlier build, or
 * damaged, and a list that throws while it renders is painted again on every
 * reload — before the fresh one can replace it — so the student could never
 * get back in. Unknown fields pass through; the server's next answer replaces
 * the whole row anyway.
 */
const cachedScoreSchema = z.object({
    assignment: z.object({
        id: z.string(),
        document_id: z.string(),
        note: z.string().nullable(),
        due_at: z.string().nullable(),
        access: z.enum(['edit', 'view']),
    }),
    document: z.object({
        id: z.string(),
        title: z.string(),
    }),
});

const cachedRowSchema = z.object({ scores: z.array(cachedScoreSchema) });

/**
 * The cached list, or null when there is none or it is not the shape the page
 * renders. All or nothing: a list missing the one piece it could not read
 * would look complete and be wrong, and the network answer is a moment away.
 */
export const parseCachedAssignments = (row: unknown): AssignedScore[] | null => {
    if (row === undefined || row === null) {
        return null;
    }
    // Validated, then the row itself is returned: the schema checks only what
    // the page reads, and stripping the rest would change what it renders.
    return cachedRowSchema.safeParse(row).success ? (row as { scores: AssignedScore[] }).scores : null;
};
