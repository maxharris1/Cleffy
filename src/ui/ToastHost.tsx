import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { toasterModule } from '@/ui/toast';

/**
 * Where the toast stack lives: mounted once at the app root (App.tsx), drawn
 * the moment its lazy chunk has arrived (ui/toast), and nothing before that.
 *
 * Portalled to <body>, beside #root rather than inside it. An open Base UI
 * dialog hides and marks everything outside itself, and #root with it; the
 * stack is a live region, which that pass leaves alone, so a toast that lands
 * while a dialog is open is still announced, seen and swipeable.
 */
export const ToastHost = () => {
    const module = useSyncExternalStore(toasterModule.subscribe, toasterModule.get, () => null);
    if (!module || typeof document === 'undefined') {
        return null;
    }
    return createPortal(<module.AppToaster />, document.body);
};
