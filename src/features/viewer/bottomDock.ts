import { useCallback, useSyncExternalStore } from 'react';

const docks = new Map<Element, number>();
const listeners = new Set<() => void>();
let height = 0;

const publish = () => {
    height = docks.size === 0 ? 0 : Math.max(...docks.values());
    const root = document.documentElement.style;
    if (docks.size === 0) {
        root.removeProperty('--viewer-bottom-dock');
    } else {
        root.setProperty('--viewer-bottom-dock', `${height}px`);
    }
    listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The tallest mounted dock's height: what --viewer-bottom-dock raises the phone pager and zoom row by. */
export const useBottomDockHeight = () => useSyncExternalStore(subscribe, () => height);

export const useBottomDock = () =>
    useCallback((element: HTMLElement | null) => {
        if (!element) {
            return;
        }
        const measure = () => {
            docks.set(element, Math.round(element.getBoundingClientRect().height));
            publish();
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(element);
        measure();
        return () => {
            observer?.disconnect();
            docks.delete(element);
            publish();
        };
    }, []);
