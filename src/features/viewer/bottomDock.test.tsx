import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomDock } from '@/features/viewer/bottomDock';

const Dock = ({ height }: { height: number }) => <div ref={useBottomDock()} data-height={height} />;

const published = () => document.documentElement.style.getPropertyValue('--viewer-bottom-dock');

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const height = Number(this.dataset['height'] ?? 0);
        return { top: 0, bottom: height, height } as DOMRect;
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('useBottomDock', () => {
    it('publishes the dock’s height as --viewer-bottom-dock', () => {
        render(<Dock height={72} />);
        expect(published()).toBe('72px');
    });

    it('publishes the tallest of two docks, and the other once the tallest goes', () => {
        const { rerender } = render(
            <>
                <Dock key="short" height={48} />
                <Dock key="tall" height={120} />
            </>,
        );
        expect(published()).toBe('120px');

        rerender(
            <>
                <Dock key="short" height={48} />
            </>,
        );
        expect(published()).toBe('48px');
    });

    it('removes the property once no dock is mounted', () => {
        const { unmount } = render(<Dock height={72} />);
        unmount();
        expect(published()).toBe('');
    });
});
