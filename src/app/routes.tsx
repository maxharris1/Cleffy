import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { RequireGuest } from '@/features/auth/AuthGates';
import { AuthCallbackPage } from '@/features/auth/AuthCallbackPage';
import { LibraryPage } from '@/features/library/LibraryPage';
import { LibraryShell } from '@/features/library/LibraryShell';
import { NotFoundPage } from '@/features/marketing/NotFoundPage';
import { BrandLoading } from '@/ui/BrandShell';
import { LoadingText } from '@/ui/Loading';

// Lazy: keeps pdf.js (large, browser-only) out of the app-shell bundle.
const ViewerPage = lazy(() => import('@/features/viewer/ViewerPage').then((m) => ({ default: m.ViewerPage })));

// Lazy: a signed-in teacher lands on /library and never sees the storefront
// or the sign-in forms again — the hero demo and product showcase alone are
// a good slice of the shell bundle that every session used to download.
const LandingPage = lazy(() => import('@/features/marketing/LandingPage').then((m) => ({ default: m.LandingPage })));
const LoginPage = lazy(() => import('@/features/auth/LoginPage').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('@/features/auth/RegisterPage').then((m) => ({ default: m.RegisterPage })));
const ForgotPasswordPage = lazy(() =>
    import('@/features/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const UpdatePasswordPage = lazy(() =>
    import('@/features/auth/UpdatePasswordPage').then((m) => ({ default: m.UpdatePasswordPage })),
);
// Lazy: IMSLP search is its own surface with its own API module.
const SearchPage = lazy(() => import('@/features/library/SearchPage').then((m) => ({ default: m.SearchPage })));
// Lazy: the invite landing is reached once per share link, by a guest.
const JoinPage = lazy(() => import('@/features/share/JoinPage').then((m) => ({ default: m.JoinPage })));

// Lazy: the account surface is rarely visited — keep Stripe copy and the
// pricing dialog out of the shell bundle that every session pays for.
const AccountPage = lazy(() => import('@/features/account/AccountPage').then((m) => ({ default: m.AccountPage })));

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

/**
 * The billing surface moved to /account, but Stripe returns users to /settings:
 * the checkout and portal Edge Functions build those URLs server-side
 * (`/settings?checkout=success|cancelled`, `/settings`) and deploy on their own
 * cadence, so the old path has to keep resolving no matter what the frontend
 * does. The query string carries the checkout outcome — forward it verbatim.
 */
const SettingsRedirect = () => {
    const { search } = useLocation();
    return <Navigate to={{ pathname: '/account', search }} replace />;
};

/** Full-page loading frame for standalone routes that render outside the shell. */
const PageFallback = ({ label }: { label: string }) => (
    <main className="flex min-h-full items-center justify-center p-8">
        <LoadingText>{label}</LoadingText>
    </main>
);

export const AppRoutes = () => {
    return (
        <Routes>
            {/* Gate before the lazy chunk: a registered knownSession redirects
                on the first paint instead of a blank frame. BrandLoading
                matches RequireGuest's own cold-start, so the fallback is not
                a second caption in front of the storefront. */}
            <Route
                path="/"
                element={
                    <RequireGuest>
                        <Suspense fallback={<BrandLoading />}>
                            <LandingPage />
                        </Suspense>
                    </RequireGuest>
                }
            />
            <Route
                path="/login"
                element={
                    <Suspense fallback={<PageFallback label="Loading sign-in…" />}>
                        <LoginPage />
                    </Suspense>
                }
            />
            <Route
                path="/register"
                element={
                    <Suspense fallback={<PageFallback label="Loading sign-up…" />}>
                        <RegisterPage />
                    </Suspense>
                }
            />
            <Route
                path="/forgot-password"
                element={
                    <Suspense fallback={<PageFallback label="Loading…" />}>
                        <ForgotPasswordPage />
                    </Suspense>
                }
            />
            <Route
                path="/update-password"
                element={
                    <Suspense fallback={<PageFallback label="Loading…" />}>
                        <UpdatePasswordPage />
                    </Suspense>
                }
            />
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
                <Route
                    path="/search"
                    element={
                        <Suspense fallback={<LoadingText className="mt-10">Loading search…</LoadingText>}>
                            <SearchPage />
                        </Suspense>
                    }
                />
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
                    path="/account"
                    element={
                        <Suspense fallback={<LoadingText className="mt-10">Loading account…</LoadingText>}>
                            <AccountPage />
                        </Suspense>
                    }
                />
                {/* Inside the shell group so the redirect still sits behind RequireRegistered. */}
                <Route path="/settings" element={<SettingsRedirect />} />
            </Route>
            <Route
                path="/doc/:documentId"
                element={
                    <Suspense fallback={<PageFallback label="Loading viewer…" />}>
                        <ViewerPage />
                    </Suspense>
                }
            />
            <Route
                path="/join/:token"
                element={
                    <Suspense fallback={<PageFallback label="Opening invite…" />}>
                        <JoinPage />
                    </Suspense>
                }
            />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="*" element={<NotFoundPage />} />
        </Routes>
    );
};
