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

const ViewerFallback = () => (
    <main className="flex min-h-full items-center justify-center p-8">
        <LoadingText>Loading viewer…</LoadingText>
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
            <Route element={<LibraryShell />}>
                <Route path="/library" element={<LibraryPage />} />
                <Route path="/search" element={<SearchPage />} />
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
                    <Suspense fallback={<ViewerFallback />}>
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
