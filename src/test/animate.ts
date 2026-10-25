import { vi } from 'vitest';

/**
 * jsdom has no Web Animations. Stand one in for lib/shake, recording which
 * element was animated, and choose whether the system asks for less motion.
 * Returns the spy and an undo for afterEach.
 */
export const stubAnimate = ({ reducedMotion = false }: { reducedMotion?: boolean } = {}) => {
    const animate = vi.fn(function (this: Element) {
        return { finished: Promise.resolve() } as unknown as Animation;
    });
    Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true, writable: true });
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: reducedMotion && query.includes('reduce'),
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        })),
    );
    const restore = () => {
        delete (Element.prototype as { animate?: unknown }).animate;
        vi.unstubAllGlobals();
    };
    return { animate, restore };
};
