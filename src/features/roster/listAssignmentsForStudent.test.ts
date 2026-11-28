import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { listAssignmentsForStudent } from '@/features/roster/rosterService';
import type { AssignmentRow } from '@/types/database';

/** supabase/config.toml's api.max_rows: PostgREST never returns more rows than this in one response. */
const MAX_ROWS = 1000;

const assignment = (n: number, studentUserId: string): AssignmentRow => ({
    id: `a-${String(n).padStart(5, '0')}`,
    document_id: `doc-${n}`,
    student_user_id: studentUserId,
    assigned_by: 'teacher-1',
    note: null,
    due_at: null,
    access: 'edit',
    created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
});

const table: AssignmentRow[] = [];

/** A PostgREST stand-in: filters by `eq.`, orders newest first, honours offset/limit, and caps at max_rows. */
const transport = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const params = url.searchParams;
    if (url.pathname.endsWith('/documents')) {
        const ids = (params.get('id') ?? '').replace(/^in\.\(|\)$/g, '').split(',');
        return Response.json(ids.map((id) => ({ id: id.replace(/"/g, ''), title: `Title of ${id}` })));
    }
    const student = params.get('student_user_id')?.replace(/^eq\./, '');
    const rows = table
        .filter((row) => student === undefined || row.student_user_id === student)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const offset = Number(params.get('offset') ?? 0);
    const limit = Math.min(Number(params.get('limit') ?? MAX_ROWS), MAX_ROWS);
    return Response.json(rows.slice(offset, offset + limit));
});

const client = createClient('http://postgrest.test', 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: transport },
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));

describe('listAssignmentsForStudent', () => {
    it('finds the student’s one assignment beneath a thousand newer ones to other students', async () => {
        table.length = 0;
        table.push(assignment(0, 'leo'));
        for (let n = 1; n <= MAX_ROWS; n++) {
            table.push(assignment(n, `other-${n % 7}`));
        }

        const rows = await listAssignmentsForStudent('leo');

        expect(rows.map(({ assignment: row }) => row.id)).toEqual(['a-00000']);
        expect(rows[0]?.documentTitle).toBe('Title of doc-0');
    });

    it('reads every page when the student alone has more assignments than one response holds', async () => {
        table.length = 0;
        for (let n = 0; n < MAX_ROWS + 5; n++) {
            table.push(assignment(n, 'leo'));
        }

        const rows = await listAssignmentsForStudent('leo');

        expect(rows).toHaveLength(MAX_ROWS + 5);
        expect(new Set(rows.map(({ assignment: row }) => row.id)).size).toBe(MAX_ROWS + 5);
    });
});
