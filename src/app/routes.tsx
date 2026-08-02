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
import { JoinPage } from '@/features/share/JoinPage';

// Lazy: keeps pdf.js (large, browser-only) out of the app-shell bundle.
const ViewerPage = lazy(() => import('@/features/viewer/ViewerPage').then((m) => ({ default: m.ViewerPage })));

const ViewerFallback = () => (
    <main className="flex min-h-full items-center justify-center p-8">
        <p className="animate-pulse text-stone-500">Loading viewer…</p>
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
        </Routes>
    );
};
