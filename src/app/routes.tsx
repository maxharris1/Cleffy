import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';

import { AuthCallbackPage } from '@/features/auth/AuthCallbackPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { UpdatePasswordPage } from '@/features/auth/UpdatePasswordPage';
import { LibraryPage } from '@/features/library/LibraryPage';
import { LibraryShell } from '@/features/library/LibraryShell';
import { SearchPage } from '@/features/library/SearchPage';
import { LandingPage } from '@/features/marketing/LandingPage';
import { NotFoundPage } from '@/features/marketing/NotFoundPage';
import { JoinPage } from '@/features/share/JoinPage';
import { LoadingText } from '@/ui/Loading';

// Lazy: keeps pdf.js (large, browser-only) out of the app-shell bundle.
const ViewerPage = lazy(() => import('@/features/viewer/ViewerPage').then((m) => ({ default: m.ViewerPage })));

// Lazy: billing is a rarely-visited surface — keep Stripe copy and the pricing
// dialog out of the shell bundle that every session pays for.
const SettingsPage = lazy(() => import('@/features/billing/SettingsPage').then((m) => ({ default: m.SettingsPage })));

// Lazy: the student surfaces are the other half of the app — a teacher session never
// mounts them, and a student loads only these, so neither side pays for the other.
const StudentLoginPage = lazy(() =>
    import('@/features/student/StudentLoginPage').then((m) => ({ default: m.StudentLoginPage })),
);
const StudentClaimPage = lazy(() =>
    import('@/features/student/StudentClaimPage').then((m) => ({ default: m.StudentClaimPage })),
);
const StudentWelcomePage = lazy(() =>
    import('@/features/student/StudentWelcomePage').then((m) => ({ default: m.StudentWelcomePage })),
);
const AssignmentsPage = lazy(() =>
    import('@/features/student/AssignmentsPage').then((m) => ({ default: m.AssignmentsPage })),
);

// Lazy: the roster is a Teacher/Academy-only surface — personal accounts never open it.
const RosterPage = lazy(() => import('@/features/roster/RosterPage').then((m) => ({ default: m.RosterPage })));

/** Full-page loading frame for standalone routes that render outside the shell. */
const PageFallback = ({ label }: { label: string }) => (
    <main className="flex min-h-full items-center justify-center p-8">
        <LoadingText>{label}</LoadingText>
    </main>
);

export const AppRoutes = () => {
    return (
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/update-password" element={<UpdatePasswordPage />} />
            {/* Public: a student arrives with a username or email and no session yet. */}
            <Route
                path="/student"
                element={
                    <Suspense fallback={<PageFallback label="Loading sign-in…" />}>
                        <StudentLoginPage />
                    </Suspense>
                }
            />
            {/* Public: the printed setup code is spent here, before any session exists. */}
            <Route
                path="/student/claim"
                element={
                    <Suspense fallback={<PageFallback label="Loading setup…" />}>
                        <StudentClaimPage />
                    </Suspense>
                }
            />
            {/* Public by necessity: the invite link's session is hydrated out of the
                URL fragment on this page, so no gate can run ahead of it. */}
            <Route
                path="/student/welcome"
                element={
                    <Suspense fallback={<PageFallback label="Loading setup…" />}>
                        <StudentWelcomePage />
                    </Suspense>
                }
            />
            {/* Bare like LibraryShell: the page mounts its own RequireStudent gate. */}
            <Route
                path="/assignments"
                element={
                    <Suspense fallback={<PageFallback label="Loading assignments…" />}>
                        <AssignmentsPage />
                    </Suspense>
                }
            />
            <Route element={<LibraryShell />}>
                <Route path="/library" element={<LibraryPage />} />
                <Route path="/search" element={<SearchPage />} />
                {/* Inside the shell group: inherits its RequireRegistered gate and chrome. */}
                <Route
                    path="/students"
                    element={
                        <Suspense fallback={<LoadingText className="mt-10">Loading roster…</LoadingText>}>
                            <RosterPage />
                        </Suspense>
                    }
                />
                <Route
                    path="/settings"
                    element={
                        <Suspense fallback={<LoadingText className="mt-10">Loading settings…</LoadingText>}>
                            <SettingsPage />
                        </Suspense>
                    }
                />
            </Route>
            <Route
                path="/doc/:documentId"
                element={
                    <Suspense fallback={<PageFallback label="Loading viewer…" />}>
                        <ViewerPage />
                    </Suspense>
                }
            />
            <Route path="/join/:token" element={<JoinPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="*" element={<NotFoundPage />} />
        </Routes>
    );
};
