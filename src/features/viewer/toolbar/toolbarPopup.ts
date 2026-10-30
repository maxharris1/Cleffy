import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether one of the toolbar's popups (the phone's colour and size popover)
 * is open, for floating UI that would otherwise sit over it: the demo's value
 * card steps aside until it closes. A count, so a popup's StrictMode re-run
 * or a second toolbar mounting during a remount cannot clear another's.
 */
let openPopups = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const isToolbarPopupOpen = () => openPopups > 0;

/** Counts a popup as open while `open` holds and its component is mounted. */
export const useReportToolbarPopup = (open: boolean) => {
    useEffect(() => {
        if (!open) {
            return;
        }
        openPopups += 1;
        notify();
        return () => {
            openPopups -= 1;
            notify();
        };
    }, [open]);
};

export const useToolbarPopupOpen = (): boolean => useSyncExternalStore(subscribe, isToolbarPopupOpen, () => false);
