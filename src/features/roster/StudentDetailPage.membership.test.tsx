import { createClient } from '@supabase/supabase-js';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StudentDetailPage } from '@/features/roster/StudentDetailPage';
import type { ManagedStudentRow } from '@/types/database';

const MAX_ROWS = 1000;

const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const member = (n: number): ManagedStudentRow => ({
    id: idOf(n),
    teacher_id: 'teacher-1',
    student_user_id: `student-user-${n}`,
    display_name: `Member ${n}`,
    parent_email: null,
    auth_method: 'code',
    username: null,
    student_email: null,
    claimed_at: null,
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    country: null,
    age_attested_at: null,
    age_attested_min_age: null,
});

const roster = Array.from({ length: MAX_ROWS + 1 }, (_, i) => member(i + 1));

const transport = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith('/managed_students')) {
        return Response.json([]);
    }
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const rows = roster.filter((row) => id === undefined || row.id === id).slice(0, MAX_ROWS);
    if (url.searchParams.has('id') && !/^[0-9a-f-]{36}$/.test(id ?? '')) {
        return Response.json({ code: '22P02', message: 'invalid input syntax for type uuid' }, { status: 400 });
    }
    return Response.json(rows);
});

const client = createClient('http://postgrest.test', 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: transport },
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));

vi.mock('@/features/library/ScoreThumb', () => ({
    ScoreThumb: () => null,
}));

const renderAt = (path: string) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route element={<Outlet context={{ userId: 'teacher-1' }} />}>
                    <Route path="/students/:studentId" element={<StudentDetailPage />} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );

afterEach(() => {
    cleanup();
    transport.mockClear();
});

describe('StudentDetailPage roster membership', () => {
    it('opens a member who sits past the first thousand on the roster', async () => {
        renderAt(`/students/${idOf(MAX_ROWS + 1)}`);

        expect(await screen.findByRole('heading', { level: 1, name: `Member ${MAX_ROWS + 1}` })).toBeInTheDocument();
    });

    it('opens the first member too', async () => {
        renderAt(`/students/${idOf(1)}`);

        expect(await screen.findByRole('heading', { level: 1, name: 'Member 1' })).toBeInTheDocument();
    });

    it('shows not-found for a well-formed id that is not on the roster', async () => {
        renderAt(`/students/${idOf(MAX_ROWS + 2)}`);

        expect(await screen.findByRole('heading', { name: 'Tacet.' })).toBeInTheDocument();
    });

    it('shows not-found for an id that is not a student id at all', async () => {
        renderAt('/students/not-a-student');

        expect(await screen.findByRole('heading', { name: 'Tacet.' })).toBeInTheDocument();
    });
});
