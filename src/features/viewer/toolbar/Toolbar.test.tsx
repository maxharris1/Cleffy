import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationStore } from '@/sync/annotationStore';
import { effectiveBox, useViewport } from '@/test/touchLayout';

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

const fingerSwitch = () => screen.queryByRole('group', { name: 'What a finger does' });

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
        for (const name of ['Finger scrolls', 'Finger draws', 'Undo', 'Redo']) {
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

        expect(fingerSwitch()).toBeNull();
        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();
    });

    it('shows the finger switch on a fine-pointer device once a touch is observed', async () => {
        useViewport({ width: 1280, coarse: false });
        const { useViewerStore } = await renderToolbar();
        expect(fingerSwitch()).toBeNull();

        act(() => useViewerStore.getState().notePointer('touch'));
        expect(fingerSwitch()).toBeInTheDocument();

        act(() => useViewerStore.getState().notePointer('pen'));
        expect(fingerSwitch()).toBeNull();
    });

    it('drops the finger switch once a stylus has been seen, even with finger drawing on', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        act(() => useViewerStore.setState({ fingerDraws: true }));
        expect(fingerSwitch()).toBeInTheDocument();

        act(() => useViewerStore.getState().notePointer('pen'));
        expect(fingerSwitch()).toBeNull();
    });

    it('leads the bar with a Scroll | Draw switch that holds fingerDraws, in place of the Finger toggle', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();
        const group = fingerSwitch() as HTMLElement;
        const scroll = within(group).getByRole('button', { name: 'Finger scrolls' });
        const draw = within(group).getByRole('button', { name: 'Finger draws' });
        expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();
        expect(group.compareDocumentPosition(screen.getByRole('button', { name: 'Pen' }))).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(group.querySelector('[data-segmented-indicator]')).not.toBeNull();
        expect(scroll).toHaveAttribute('aria-pressed', 'true');
        expect(draw).toHaveAttribute('aria-pressed', 'false');

        await user.click(draw);
        expect(useViewerStore.getState().fingerDraws).toBe(true);
        expect(draw).toHaveAttribute('aria-pressed', 'true');
        expect(scroll).toHaveAttribute('aria-pressed', 'false');

        await user.click(scroll);
        expect(useViewerStore.getState().fingerDraws).toBe(false);
        expect(scroll).toHaveAttribute('aria-pressed', 'true');
    });

    it('labels the switch Scroll and Draw from sm, and keeps it icon-only on a phone', async () => {
        useViewport({ width: 390, coarse: true });
        await renderToolbar();

        for (const [name, text] of [
            ['Finger scrolls', 'Scroll'],
            ['Finger draws', 'Draw'],
        ] as const) {
            const key = screen.getByRole('button', { name });
            expect(key.querySelector('svg')).not.toBeNull();
            expect(within(key).getByText(text)).toHaveClass('hidden', 'sm:inline');
        }
    });

    it('dims the tools while a finger scrolls, and choosing one turns Draw on', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();
        const tools = ['Pen', 'Highlighter', 'Eraser', 'Text note'].map((name) => screen.getByRole('button', { name }));
        for (const button of tools) {
            expect(button).toHaveClass('opacity-[0.45]');
            expect(button).toBeEnabled();
        }

        await user.click(screen.getByRole('button', { name: 'Eraser' }));
        expect(useViewerStore.getState()).toMatchObject({ tool: 'eraser', fingerDraws: true });
        for (const button of tools) {
            expect(button).not.toHaveClass('opacity-[0.45]');
        }
    });

    it('keeps the tool in hand when it is chosen while a finger scrolls', async () => {
        useViewport({ width: 1024, coarse: true });
        const { useViewerStore } = await renderToolbar();
        const user = userEvent.setup();

        await user.click(screen.getByRole('button', { name: 'Pen' }));
        expect(useViewerStore.getState()).toMatchObject({ tool: 'pen', fingerDraws: true });

        await user.click(screen.getByRole('button', { name: 'Pen' }));
        expect(useViewerStore.getState().tool).toBeNull();
    });

    it('never dims the tools without the switch: a stylus or a mouse draws', async () => {
        useViewport({ width: 1280, coarse: false });
        await renderToolbar();

        expect(screen.getByRole('button', { name: 'Pen' })).not.toHaveClass('opacity-[0.45]');
    });

    it('keeps every phone control at 44px wide, scrolling the row sideways rather than shrinking them', async () => {
        useViewport({ width: 390, coarse: true });
        await renderToolbar();
        const bar = (fingerSwitch() as HTMLElement).parentElement as HTMLElement;

        expect(bar).toHaveClass('max-sm:overflow-x-auto', 'flex-nowrap');
        expect(bar).not.toHaveClass('relative');
        for (const button of Array.from(bar.querySelectorAll<HTMLElement>(':scope > button'))) {
            expect(effectiveBox(button).minWidth, button.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
        }
        for (const key of within(fingerSwitch() as HTMLElement).getAllByRole('button')) {
            expect(effectiveBox(key).minWidth, key.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
        }
    });

    it('holds 44px phone targets on a fine-pointer device once a finger is seen', async () => {
        useViewport({ width: 390, coarse: false });
        const { useViewerStore } = await renderToolbar();
        act(() => useViewerStore.getState().notePointer('touch'));
        const group = fingerSwitch() as HTMLElement;
        const bar = group.parentElement as HTMLElement;

        for (const button of Array.from(bar.querySelectorAll<HTMLElement>(':scope > button'))) {
            const box = effectiveBox(button);
            const name = button.getAttribute('aria-label') ?? '';
            expect(box.minWidth, name).toBeGreaterThanOrEqual(44);
            expect(box.hit44y, name).toBe(true);
        }
        const trough = effectiveBox(group);
        const keyHeight = trough.height - trough.paddingTop - trough.paddingBottom;
        for (const key of within(group).getAllByRole('button')) {
            const box = effectiveBox(key);
            const name = key.getAttribute('aria-label') ?? '';
            expect(box.minWidth, name).toBeGreaterThanOrEqual(44);
            expect(keyHeight + 2 * box.overhangY, name).toBeGreaterThanOrEqual(44);
        }

        await userEvent.setup().click(screen.getByRole('button', { name: 'Pen colour and size' }));
        const popover = screen.getByRole('group', { name: 'Pen colour and size' });
        for (const button of within(popover).getAllByRole('button')) {
            expect(effectiveBox(button).hit44, button.getAttribute('aria-label') ?? '').toBe(true);
        }
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
