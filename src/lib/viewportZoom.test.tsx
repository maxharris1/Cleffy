import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as viewportZoom from '@/lib/viewportZoom';
import { VIEWPORT_ZOOMABLE } from '@/lib/viewportZoom';

/** Resolved from the project root: jsdom gives import.meta a non-file URL. */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const shippedViewport = (): string => {
    const match = read('index.html').match(/<meta\s+name="viewport"\s+content="([^"]*)"/);
    expect(match, 'index.html has no viewport meta').not.toBeNull();
    return match?.[1] ?? '';
};

describe('viewport zoom', () => {
    it('ships a page people can zoom (WCAG 1.4.4)', () => {
        const content = shippedViewport();
        expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
        expect(content).not.toMatch(/maximum-scale/i);
        expect(content).toBe(VIEWPORT_ZOOMABLE);
    });

    it('never locks zoom from script, the viewer included', () => {
        const viewport = read('src/features/viewer/PdfViewport.tsx');
        expect(viewport).not.toMatch(/user-scalable|maximum-scale|useLockedPageZoom/);
        expect(Object.keys(viewportZoom)).toEqual(['VIEWPORT_ZOOMABLE']);
    });

    it('keeps pinch on the score with touch-action instead', () => {
        // The score surface is touch-action: none, so the browser leaves pinch to
        // GestureController; the viewer's floating controls live inside it.
        const css = read('src/index.css');
        expect(css).toMatch(/\.ink-surface\s*\{[^}]*touch-action:\s*none/);
        expect(read('src/features/viewer/PdfViewport.tsx')).toMatch(/className="ink-surface /);
    });
});
