import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const renderToolbar = async (onObscuredChange?: (edges: { top: number; bottom: number }) => void) => {
    vi.resetModules();
    const { Toolbar } = await import('@/features/viewer/toolbar/Toolbar');
    const { useViewerStore } = await import('@/state/store');
    useViewerStore.setState({ tool: 'pen', color: '#1f2937', widthKey: 'medium' });
    const view = render(
        <div data-testid="viewport">
            <Toolbar store={fakeStore} onObscuredChange={onObscuredChange} />
        </div>,
    );
    return { ...view, useViewerStore };
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

    it('keeps every tool and control, with colours and sizes behind one style button on phones', async () => {
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();

        // The phone bar: no tool added or removed, only the style controls folded.
        for (const name of ['Undo', 'Redo', 'Draw with finger']) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument();
        }
        const style = screen.getByRole('button', { name: 'Pen colour and size' });
        expect(style).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('group', { name: 'Pen colour and size' })).not.toBeInTheDocument();

        await user.click(style);
        expect(style).toHaveAttribute('aria-expanded', 'true');
        const popover = screen.getByRole('group', { name: 'Pen colour and size' });
        expect(style).toHaveAttribute('aria-controls', popover.id);
        expect(within(popover).getAllByRole('button', { name: /^Color #/ })).toHaveLength(7);
        expect(within(popover).getAllByRole('button', { name: /^Pen size / })).toHaveLength(3);

        await user.click(within(popover).getByRole('button', { name: 'Color #dc2626' }));
        await user.click(within(popover).getByRole('button', { name: 'Pen size Thick' }));
        expect(useViewerStore.getState().color).toBe('#dc2626');
        expect(useViewerStore.getState().widthKey).toBe('thick');
        // Still open: colour and size are usually picked together.
        expect(screen.getByRole('group', { name: 'Pen colour and size' })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('group', { name: 'Pen colour and size' })).not.toBeInTheDocument();
        expect(style).toHaveFocus();
    });

    it('folds colours and sizes only on phones: from sm (a portrait iPad) they stay inline, one tap each', async () => {
        await renderToolbar();

        // jsdom applies no CSS, so the breakpoints are read off the classes:
        // the style button and its divider exist below sm only…
        const style = screen.getByRole('button', { name: 'Pen colour and size' });
        expect(style).toHaveClass('sm:hidden');
        expect(style.previousElementSibling).toHaveClass('sm:hidden');
        // …and the inline colours and sizes take over from sm, not from lg.
        const inlineColors = screen.getAllByRole('button', { name: /^Color #/ });
        const inlineSizes = screen.getAllByRole('button', { name: /^Pen size / });
        expect(inlineColors).toHaveLength(7);
        expect(inlineSizes).toHaveLength(3);
        for (const button of [...inlineColors, ...inlineSizes]) {
            expect(button.parentElement).toHaveClass('hidden', 'sm:contents');
        }
        expect(document.querySelector('[class*="lg:"]')).toBeNull();
    });

    it('closes the style popover on a tap outside it or a tool change, and names what the tool styles', async () => {
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();

        await user.click(screen.getByRole('button', { name: 'Pen colour and size' }));
        await user.click(document.body);
        expect(screen.queryByRole('group', { name: 'Pen colour and size' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Pen colour and size' }));
        await user.click(screen.getByRole('button', { name: 'Eraser' }));
        expect(screen.queryByRole('group')).not.toBeInTheDocument();
        expect(useViewerStore.getState().tool).toBe('eraser');
        expect(screen.getByRole('button', { name: 'Eraser size' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Text note' }));
        expect(screen.getByRole('button', { name: 'Text colour' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Pan' }));
        expect(screen.queryByRole('button', { name: /colour|size/i })).not.toBeInTheDocument();
    });

    it('reports the strip of the viewport it covers, at the bottom on phones and at the top from sm', async () => {
        const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top }) as DOMRect;
        let barTop = 780;
        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: HTMLElement,
        ) {
            return this.dataset['testid'] === 'viewport' ? rect(0, 844) : rect(barTop, barTop + 52);
        });
        const resized: Array<() => void> = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: () => void) {
                    resized.push(callback);
                }
                observe() {}
                disconnect() {}
            },
        );
        const reports: Array<{ top: number; bottom: number }> = [];
        const { unmount } = await renderToolbar((edges) => reports.push(edges));
        // A phone: 844 - 780 px of the page sit under the bar.
        expect(reports.at(-1)).toEqual({ top: 0, bottom: 64 });

        // Wider, the bar docks at the top and covers the top 12 + 52 px instead.
        barTop = 12;
        act(() => resized.forEach((callback) => callback()));
        expect(reports.at(-1)).toEqual({ top: 64, bottom: 0 });

        unmount();
        expect(reports.at(-1)).toEqual({ top: 0, bottom: 0 });
        spy.mockRestore();
        vi.unstubAllGlobals();
    });
});
