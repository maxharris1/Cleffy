import type { ReactNode } from 'react';
import type { toast as sonnerToast } from 'sonner';

import { lazyModule } from '@/ui/lazyModule';

/**
 * Sonner and the app's toast stack (ui/toastChunk), in a chunk of their own:
 * nothing toasts during the first paint, so the shell bundle does not carry
 * them. ui/ToastHost mounts the stack the moment the chunk is in; it is
 * warmed on idle with the dialog and menu chunks (ui/lazyPrimitives).
 */
export const toasterModule = lazyModule(() => import('@/ui/toastChunk'));

export interface ToastOptions {
    /** A second, quieter line: what the toast is about (the score's title). */
    description?: ReactNode;
    /** Firing again with the same id replaces that toast instead of stacking another. */
    id?: string | number;
    /** How long it stays, in ms; Sonner's default (4s) otherwise. */
    duration?: number;
}

type SonnerToast = typeof sonnerToast;

/**
 * Fire once the chunk is in. Sonner replays toasts created before its stack
 * subscribed, so one fired while the chunk is still on its way is shown when
 * it lands, not lost. A chunk that fails to load drops the toast: it was a
 * passing confirmation, and anything that must be seen stays on the page.
 */
const fire = (show: (sonner: SonnerToast) => void): void => {
    void toasterModule.load().then(
        (module) => show(module.sonnerToast),
        () => undefined,
    );
};

/**
 * The app's toasts: transient confirmations and errors that block nothing.
 *
 * Never one per ink save, per sync or per page — those happen all lesson.
 * An error the user has to act on, or one that persists, stays on the page
 * (a ViewerNotice strip, an inline ErrorText); a toast is gone in seconds.
 */
export const toast = {
    /** Something the user asked for is done: "Score uploaded", "Assigned to Maya". */
    success: (message: string, options?: ToastOptions): void => fire((sonner) => sonner.success(message, options)),
    /** A file or a change was kept. */
    saved: (message = 'Saved', options?: ToastOptions): void => fire((sonner) => sonner.success(message, options)),
    /** Handed to someone else (the share sheet, a link). */
    shared: (message = 'Shared', options?: ToastOptions): void => fire((sonner) => sonner.success(message, options)),
    /** Something failed that the user does not have to act on. */
    error: (message: string, options?: ToastOptions): void => fire((sonner) => sonner.error(message, options)),
    /**
     * A toast that follows a promise: the loading line, then success or error.
     * Returns the same promise, so the caller still handles its outcome.
     */
    promise: <T>(
        promise: Promise<T>,
        messages: {
            loading: string;
            success: string | ((value: T) => string);
            error: string | ((err: unknown) => string);
        },
    ): Promise<T> => {
        fire((sonner) => {
            sonner.promise(promise, messages);
        });
        return promise;
    },
};
