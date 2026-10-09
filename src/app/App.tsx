import { BrowserRouter } from 'react-router';

import { BackgroundSync } from '@/app/BackgroundSync';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { AppRoutes } from '@/app/routes';

export const App = () => {
    return (
        <ErrorBoundary>
            <BackgroundSync />
            <BrowserRouter>
                <AppRoutes />
            </BrowserRouter>
        </ErrorBoundary>
    );
};
