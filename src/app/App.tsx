import { BrowserRouter } from 'react-router';

import { ErrorBoundary } from '@/app/ErrorBoundary';
import { AppRoutes } from '@/app/routes';

export const App = () => {
    return (
        <ErrorBoundary>
            <BrowserRouter>
                <AppRoutes />
            </BrowserRouter>
        </ErrorBoundary>
    );
};
