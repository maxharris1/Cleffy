import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationStore } from '@/sync/annotationStore';
import { useViewport } from '@/test/touchLayout';

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
    useViewerStore.setState({ tool: 'pen', color: '#1f2937', widthKey: 'medium', penSeen: false, touchSeen: false });
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
    vi.unstubAllGlobals();
});

describe('Toolbar', () => {
    it('offers only the core markup tools with fingering switched off', async () => {
        await renderToolbar();

        for (const name of ['Pen', 'Highlighter', 'Eraser', 'Text note']) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument();
        }
        expect(screen.queryByRole('button', { name: 'Pan' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /fingering/i })).not.toBeInTheDocument();
    });

    it('adds the Fingering tool in a build that ships it', async () => {
        flags.fingering = true;
        await renderToolbar();

        expect(screen.getByRole('button', { name: /fingering/i })).toBeInTheDocument();
    });

    it('keeps every tool and control, with colours and sizes behind one style button on phones', async () => {
        useViewport({ width: 390, coarse: true });
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

    it('has no finger switch on a mouse or trackpad', async () => {
        useViewport({ width: 1280, coarse: false });
        await renderToolbar();

        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();
    });

    it('shows the finger switch on a fine-pointer device once a touch is observed', async () => {
        useViewport({ width: 1280, coarse: false });
        const { useViewerStore } = await renderToolbar();
        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();

        act(() => useViewerStore.getState().notePointer('touch'));
        expect(screen.getByRole('button', { name: 'Draw with finger' })).toBeInTheDocument();

        act(() => useViewerStore.getState().notePointer('pen'));
        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();
    });

    it('lets a finger choose between drawing and scrolling on a touch screen with no stylus yet', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();

        await user.click(screen.getByRole('button', { name: 'Draw with finger' }));
        expect(useViewerStore.getState().fingerDraws).toBe(true);
    });

    it('drops the finger switch once a stylus has been seen, even with finger drawing on', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        act(() => useViewerStore.setState({ fingerDraws: true }));
        expect(screen.getByRole('button', { name: 'Draw with finger' })).toBeInTheDocument();

        act(() => useViewerStore.getState().notePointer('pen'));
        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();
    });

    it('folds colours and sizes below lg: inline, they wrapped a portrait iPad bar to two rows', async () => {
        await renderToolbar();

        // jsdom applies no CSS, so the breakpoints are read off the classes:
        // the style button and its divider exist below lg only…
        const style = screen.getByRole('button', { name: 'Pen colour and size' });
        expect(style).toHaveClass('lg:hidden');
        expect(style).not.toHaveClass('sm:hidden');
        expect(style.previousElementSibling).toHaveClass('lg:hidden');
        // …and the inline colours and sizes take over from lg, one tap each.
        const inlineColors = screen.getAllByRole('button', { name: /^Color #/ });
        const inlineSizes = screen.getAllByRole('button', { name: /^Pen size / });
        expect(inlineColors).toHaveLength(7);
        expect(inlineSizes).toHaveLength(3);
        for (const button of [...inlineColors, ...inlineSizes]) {
            expect(button.parentElement).toHaveClass('hidden', 'lg:contents');
        }
        expect(document.querySelector('[class*="sm:contents"]')).toBeNull();
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

        await user.click(screen.getByRole('button', { name: 'Text note' }));
        expect(screen.queryByRole('button', { name: /colour|size/i })).not.toBeInTheDocument();
    });

    it('puts the tool in hand down when it is clicked again, leaving every tool unpressed', async () => {
        flags.fingering = true;
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();
        const tools = ['Pen', 'Highlighter', 'Eraser', 'Text note', /fingering/i].map((name) =>
            screen.getByRole('button', { name }),
        );

        await user.click(screen.getByRole('button', { name: 'Pen' }));
        expect(useViewerStore.getState().tool).toBeNull();
        for (const button of tools) {
            expect(button).toHaveAttribute('aria-pressed', 'false');
        }

        await user.click(screen.getByRole('button', { name: 'Eraser' }));
        expect(useViewerStore.getState().tool).toBe('eraser');
        expect(screen.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('says while its popup is open, so floating UI (the demo’s value card) can step aside', async () => {
        const { unmount } = await renderToolbar();
        // The same fresh module copy renderToolbar loaded the Toolbar against.
        const { isToolbarPopupOpen } = await import('@/features/viewer/toolbar/toolbarPopup');
        const user = userEvent.setup();
        expect(isToolbarPopupOpen()).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Pen colour and size' }));
        expect(isToolbarPopupOpen()).toBe(true);
        expect(screen.getByRole('group', { name: 'Pen colour and size' })).toHaveAttribute('data-toolbar-popup');

        await user.keyboard('{Escape}');
        expect(isToolbarPopupOpen()).toBe(false);

        // A toolbar that goes with its popup open does not leave it counted.
        await user.click(screen.getByRole('button', { name: 'Pen colour and size' }));
        expect(isToolbarPopupOpen()).toBe(true);
        unmount();
        expect(isToolbarPopupOpen()).toBe(false);
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
