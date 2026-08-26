import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequireRegistered, RequireStudent } from '@/features/auth/AuthGates';
import type * as sessionModule from '@/features/auth/session';
import type { SessionState } from '@/features/auth/session';

const useSession = vi.fn();

// Partial mock: isRegisteredSession and userTypeOf ARE the rules under test, so
// only the hook that reaches Supabase is replaced.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => useSession(),
}));

/** Only the fields the gates read — the rest of Session is never touched. */
const sessionOf = ({ anonymous = false, userType }: { anonymous?: boolean; userType?: string } = {}): Session =>
    ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        user: {
            id: 'user-1',
            is_anonymous: anonymous,
            app_metadata: userType ? { user_type: userType } : {},
            user_metadata: {},
        },
    }) as unknown as Session;

const settled = (session: Session | null): SessionState => ({ session, loading: false, lastEvent: null });

const Landmark = ({ label }: { label: string }) => <p>{label}</p>;

const renderGate = (gate: ReactNode) =>
    render(
        <MemoryRouter initialEntries={['/gated']}>
            <Routes>
                <Route path="/gated" element={gate} />
                <Route path="/" element={<Landmark label="landing" />} />
                <Route path="/library" element={<Landmark label="library" />} />
                <Route path="/assignments" element={<Landmark label="assignments" />} />
                <Route path="/student" element={<Landmark label="student login" />} />
            </Routes>
        </MemoryRouter>,
    );

const registeredGate = (fallback?: string) => (
    <RequireRegistered fallback={fallback}>
        {(session) => <Landmark label={`teacher ${session.user.id}`} />}
    </RequireRegistered>
);

const studentGate = () => (
    <RequireStudent>{(session) => <Landmark label={`student ${session.user.id}`} />}</RequireStudent>
);

beforeEach(() => {
    vi.clearAllMocks();
    useSession.mockReturnValue(settled(null));
});

afterEach(() => {
    cleanup();
});

describe('RequireRegistered', () => {
    it('hands the session to its children for a registered teacher', () => {
        useSession.mockReturnValue(settled(sessionOf()));
        renderGate(registeredGate());
        expect(screen.getByText('teacher user-1')).toBeInTheDocument();
    });

    it('waits for bootstrap rather than bouncing a signed-in teacher to the fallback', () => {
        useSession.mockReturnValue({ session: null, loading: true, lastEvent: null });
        renderGate(registeredGate());
        expect(screen.getByText('Loading…')).toBeInTheDocument();
        expect(screen.queryByText('landing')).not.toBeInTheDocument();
    });

    it('redirects an anonymous session to the fallback', () => {
        useSession.mockReturnValue(settled(sessionOf({ anonymous: true })));
        renderGate(registeredGate('/'));
        expect(screen.getByText('landing')).toBeInTheDocument();
        expect(screen.queryByText('teacher user-1')).not.toBeInTheDocument();
    });

    it('sends a provisioned student to their assignments, not the teacher chrome', () => {
        useSession.mockReturnValue(settled(sessionOf({ userType: 'student' })));
        renderGate(registeredGate());
        expect(screen.getByText('assignments')).toBeInTheDocument();
        expect(screen.queryByText('teacher user-1')).not.toBeInTheDocument();
    });
});

describe('RequireStudent', () => {
    it('hands the session to its children for a provisioned student', () => {
        useSession.mockReturnValue(settled(sessionOf({ userType: 'student' })));
        renderGate(studentGate());
        expect(screen.getByText('student user-1')).toBeInTheDocument();
    });

    it('sends a teacher back to the library', () => {
        useSession.mockReturnValue(settled(sessionOf()));
        renderGate(studentGate());
        expect(screen.getByText('library')).toBeInTheDocument();
        expect(screen.queryByText('student user-1')).not.toBeInTheDocument();
    });

    it('sends a signed-out visitor to the code-entry page', () => {
        renderGate(studentGate());
        expect(screen.getByText('student login')).toBeInTheDocument();
        expect(screen.queryByText('student user-1')).not.toBeInTheDocument();
    });
});
