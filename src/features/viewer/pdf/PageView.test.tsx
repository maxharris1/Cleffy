import { cleanup, render } from '@testing-library/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { PageView } from '@/features/viewer/pdf/PageView';

const PHONE_SHADOW = 'shadow-[0_0_0_1px_rgba(28,25,23,0.08),0_20px_40px_-24px_rgba(28,25,23,0.5)]';
const DESKTOP_SHADOW = 'shadow-[0_0_0_1px_rgba(28,25,23,0.08),0_30px_60px_-30px_rgba(28,25,23,0.45)]';

afterEach(cleanup);

describe('PageView', () => {
    it('casts the phone page shadow below sm and the desktop one from sm up', () => {
        const doc = { getPage: () => new Promise(() => {}) } as unknown as PDFDocumentProxy;
        const registry = { register: () => {}, unregister: () => {} } as unknown as CanvasRegistry;
        const { container } = render(
            <PageView
                doc={doc}
                pageIndex={0}
                layout={{ top: 16, left: 0, width: 612, height: 792 }}
                scale={1}
                pixelRatio={1}
                registry={registry}
            />,
        );
        const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
        expect(classes).toContain(PHONE_SHADOW);
        expect(classes).toContain(`sm:${DESKTOP_SHADOW}`);
        expect(classes).not.toContain(DESKTOP_SHADOW);
    });
});
