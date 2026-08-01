import { BrowserRouter } from 'react-router';

import { AppRoutes } from '@/app/routes';

export const App = () => {
    return (
        <BrowserRouter>
            <AppRoutes />
        </BrowserRouter>
    );
};
