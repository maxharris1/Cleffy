import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';

import { AuthCallbackPage } from '@/features/auth/AuthCallbackPage';
import { LibraryPage } from '@/features/library/LibraryPage';
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
            <Route path="/" element={<LibraryPage />} />
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
