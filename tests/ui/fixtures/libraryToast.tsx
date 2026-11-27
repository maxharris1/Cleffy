import '@/index.css';

import { createRoot } from 'react-dom/client';

import { toast } from '@/ui/toast';
import { ToastHost } from '@/ui/ToastHost';

declare global {
    interface Window {
        showFavoriteError: () => void;
    }
}

window.showFavoriteError = () => toast.error('Could not update favorites.', { duration: 60_000 });

createRoot(document.getElementById('root')!).render(<ToastHost />);
