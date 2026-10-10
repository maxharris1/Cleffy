import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useLockedPageZoom, VIEWPORT_ZOOM_LOCKED, VIEWPORT_ZOOMABLE } from '@/lib/viewportZoom';

/** Resolved from the project root: jsdom gives import.meta a non-file URL. */
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const shippedViewport = (): string => {
    const match = INDEX_HTML.match(/<meta\s+name="viewport"\s+content="([^"]*)"/);
    expect(match, 'index.html has no viewport meta').not.toBeNull();
    return match?.[1] ?? '';
};

const Viewer = () => {
    useLockedPageZoom();
    return null;
};

const currentViewport = () => document.querySelector('meta[name="viewport"]')?.getAttribute('content');

describe('viewport zoom', () => {
    beforeEach(() => {
        const meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = VIEWPORT_ZOOMABLE;
        document.head.appendChild(meta);
    });

    afterEach(() => {
        cleanup();
        document.querySelector('meta[name="viewport"]')?.remove();
    });

    it('ships a page people can zoom (WCAG 1.4.4)', () => {
        const content = shippedViewport();
        expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
        expect(content).not.toMatch(/maximum-scale/i);
        // The value the viewer restores on the way out is the one index.html ships.
        expect(content).toBe(VIEWPORT_ZOOMABLE);
    });

    it('locks page zoom only while a score viewer is mounted', () => {
        const { unmount } = render(
            <StrictMode>
                <Viewer />
            </StrictMode>,
        );
        expect(currentViewport()).toBe(VIEWPORT_ZOOM_LOCKED);
        unmount();
        expect(currentViewport()).toBe(VIEWPORT_ZOOMABLE);
    });

    it('stays locked while another viewer is still mounted', () => {
        const first = render(<Viewer />);
        const second = render(<Viewer />);
        first.unmount();
        expect(currentViewport()).toBe(VIEWPORT_ZOOM_LOCKED);
        second.unmount();
        expect(currentViewport()).toBe(VIEWPORT_ZOOMABLE);
    });
});
