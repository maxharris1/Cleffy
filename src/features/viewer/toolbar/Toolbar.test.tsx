import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationStore } from '@/sync/annotationStore';

/**
 * The markup toolbar is the release's one annotation surface. Its tool list is
 * fixed at module load from the build's flags, so each case loads a fresh copy
 * of the module against the flags it is testing.
 */

const flags = vi.hoisted(() => ({ playalong: false, fingering: false, printHandwriting: false }));
vi.mock('@/lib/features', () => ({ features: flags }));

const fakeStore = {
    canUndo: false,
    canRedo: false,
    subscribeMeta: () => () => undefined,
    undoLast: vi.fn(),
    redoLast: vi.fn(),
} as unknown as AnnotationStore;

const renderToolbar = async () => {
    vi.resetModules();
    const { Toolbar } = await import('@/features/viewer/toolbar/Toolbar');
    render(<Toolbar store={fakeStore} />);
};

afterEach(() => {
    cleanup();
    flags.fingering = false;
});

describe('Toolbar', () => {
    it('offers only the core markup tools with fingering switched off', async () => {
        await renderToolbar();

        for (const name of ['Pan', 'Pen', 'Highlighter', 'Eraser', 'Text note']) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument();
        }
        expect(screen.queryByRole('button', { name: /fingering/i })).not.toBeInTheDocument();
    });

    it('adds the Fingering tool in a build that ships it', async () => {
        flags.fingering = true;
        await renderToolbar();

        expect(screen.getByRole('button', { name: /fingering/i })).toBeInTheDocument();
    });
});
