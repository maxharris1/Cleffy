import '@/index.css';

import { createRoot } from 'react-dom/client';

import { toast } from '@/ui/toast';
import { ToastHost } from '@/ui/ToastHost';

declare global {
    interface Window {
        showFavoriteError: () => void;
        showMarksRestored: () => void;
    }
}

window.showFavoriteError = () => toast.error('Could not update favorites.', { duration: 60_000 });

window.showMarksRestored = () =>
    toast.success('Marks restored', {
        description: 'To the starting point of Mon, Nov 16, 2026. Undo brings back what was there.',
        duration: 60_000,
    });

createRoot(document.getElementById('root')!).render(<ToastHost />);
