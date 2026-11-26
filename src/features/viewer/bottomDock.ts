import { useCallback } from 'react';

const docks = new Map<Element, number>();

const publish = () => {
    const root = document.documentElement.style;
    if (docks.size === 0) {
        root.removeProperty('--viewer-bottom-dock');
        return;
    }
    root.setProperty('--viewer-bottom-dock', `${Math.max(...docks.values())}px`);
};

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
