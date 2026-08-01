import { Route, Routes } from 'react-router';

import { AuthCallbackPage } from '@/features/auth/AuthCallbackPage';
import { LibraryPage } from '@/features/library/LibraryPage';
import { JoinPage } from '@/features/share/JoinPage';
import { ViewerPage } from '@/features/viewer/ViewerPage';

export const AppRoutes = () => {
    return (
        <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/doc/:documentId" element={<ViewerPage />} />
            <Route path="/join/:token" element={<JoinPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
        </Routes>
    );
};
