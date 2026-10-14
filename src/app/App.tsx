import { BrowserRouter } from 'react-router';

import { BackgroundSync } from '@/app/BackgroundSync';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { AppRoutes } from '@/app/routes';
import { AuthLinkErrorNotice } from '@/features/auth/AuthLinkErrorNotice';

export const App = () => {
    return (
        // Outermost, so it also catches the router and BackgroundSync; its
        // fallback therefore uses no router (see ErrorBoundary).
        <ErrorBoundary>
            <BackgroundSync />
            <BrowserRouter>
                <AppRoutes />
                <AuthLinkErrorNotice />
            </BrowserRouter>
        </ErrorBoundary>
    );
};
