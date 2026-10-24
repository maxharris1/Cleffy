import { BrowserRouter } from 'react-router';

import { BackgroundSync } from '@/app/BackgroundSync';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { AppRoutes } from '@/app/routes';
import { SignedOutInkGate } from '@/app/SignedOutInkGate';
import { AuthLinkErrorNotice } from '@/features/auth/AuthLinkErrorNotice';
import { ToastHost } from '@/ui/ToastHost';

export const App = () => {
    return (
        // Outermost, so it also catches the router and BackgroundSync; its
        // fallback therefore uses no router (see ErrorBoundary).
        <ErrorBoundary>
            <BackgroundSync />
            <BrowserRouter>
                <AppRoutes />
                <AuthLinkErrorNotice />
                <SignedOutInkGate />
                {/* The one toast stack, portalled to <body> outside any dialog. */}
                <ToastHost />
            </BrowserRouter>
        </ErrorBoundary>
    );
};
