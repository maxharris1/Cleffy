import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDocumentLayout, pageFitView } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { exitStandMode } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { Annotation, TextPayload } from '@/types/models';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({
    PageView: ({ pageIndex }: { pageIndex: number }) => <div data-testid="page" data-page={pageIndex} />,
}));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

const VIEWPORT = { width: 800, height: 600 };
const LAYOUT = computeDocumentLayout(PAGE_SIZES, 1, false);

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => VIEWPORT.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEWPORT.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT }),
    );
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
    useViewerStore.getState().setTool('pen');
    useViewerStore.getState().setFingerDraws(false);
});

afterEach(() => {
    exitStandMode();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useViewerStore.getState().setTool('pen');
    useViewerStore.getState().setFingerDraws(false);
});

const surface = () => document.querySelector<HTMLElement>('.ink-surface')!;
const shownPage = () => Number(screen.getByTestId('page').dataset.page);

const pointer = (type: string, pointerType: string, x: number, y: number, pointerId: number) =>
    act(() => {
        surface().dispatchEvent(
            new PointerEvent(type, { pointerId, pointerType, clientX: x, clientY: y, button: 0, bubbles: true }),
        );
    });

/** Two fingers spreading apart around (cx, cy): a pinch-out. */
const pinchOut = (cx: number, cy: number) => {
    pointer('pointerdown', 'touch', cx - 50, cy, 11);
    pointer('pointerdown', 'touch', cx + 50, cy, 12);
    pointer('pointermove', 'touch', cx + 100, cy, 12);
    pointer('pointermove', 'touch', cx + 150, cy, 12);
    pointer('pointerup', 'touch', cx + 150, cy, 12);
    pointer('pointerup', 'touch', cx - 50, cy, 11);
};

/**
 * The viewer with a text note on page 1 that the text tool has selected: the
 * reader typed it, finished editing, and it stayed selected (its box and
 * corner handle up, so a two-finger pinch resizes it outside stand mode).
 */
const renderWithSelectedNote = async () => {
    let store: AnnotationStore | null = null;
    render(
        <>
            <StandModeButton />
            <PdfViewport docId={`doc-stand-notes-${crypto.randomUUID()}`} onStoreReady={(s) => (store = s)} />
        </>,
    );
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
    act(() => useViewerStore.getState().setTool('text'));
    // A click on page 1 opens a new note's editor; Enter finishes it.
    pointer('pointerdown', 'mouse', 300, 200, 1);
    pointer('pointerup', 'mouse', 300, 200, 1);
    const editor = await screen.findByRole('textbox', { name: 'Text note' });
    fireEvent.change(editor, { target: { value: 'dolce' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    const annotations = store as unknown as AnnotationStore;
    await waitFor(() => expect(annotations.getPage(0).size).toBe(1));
    expect(useViewerStore.getState().selectedTextId).not.toBeNull();
    const note = [...annotations.getPage(0).values()][0]!;
    // Well after the click: touches that soon after an ink pointer are taken as a palm.
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 10_000);
    return { store: annotations, note };
};

const payloadOf = (store: AnnotationStore, note: Annotation) => store.get(note.id)!.payload as TextPayload;

describe('stand mode leaves a selected text note alone', () => {
    it('resizes the selected note on a pinch outside stand mode (the control case)', async () => {
        const { store, note } = await renderWithSelectedNote();
        const before = payloadOf(store, note).size;
        pinchOut(400, 300);
        await waitFor(() => expect(payloadOf(store, note).size).toBeGreaterThan(before));
    });

    const pinchCases = [
        { name: 'on the page the note is on', page: 0 },
        { name: 'after turning to another page', page: 2 },
    ] as const;

    for (const fingerDraws of [false, true]) {
        for (const { name, page } of pinchCases) {
            it(`a pinch ${name} changes no annotation and no undo history (Finger-draw ${fingerDraws ? 'on' : 'off'})`, async () => {
                const { store, note } = await renderWithSelectedNote();
                act(() => useViewerStore.getState().setFingerDraws(fingerDraws));
                const before = { ...payloadOf(store, note) };
                const update = vi.spyOn(store, 'update');
                const create = vi.spyOn(store, 'create');
                const remove = vi.spyOn(store, 'delete');
                const beginBatch = vi.spyOn(store, 'beginBatch');

                fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
                expect(useViewerStore.getState().standMode).toBe(true);
                for (let i = 0; i < page; i++) {
                    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
                }
                expect(shownPage()).toBe(page);

                pinchOut(400, 300);
                pinchOut(250, 450);
                // Let any write the pinch started land before looking.
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 30));
                });

                expect(update).not.toHaveBeenCalled();
                expect(create).not.toHaveBeenCalled();
                expect(remove).not.toHaveBeenCalled();
                expect(beginBatch).not.toHaveBeenCalled();
                expect(payloadOf(store, note)).toEqual(before);
                // The page stays as stand mode placed it: a pinch neither zooms it nor resizes the note.
                expect(useViewerStore.getState().view).toEqual(
                    pageFitView(LAYOUT, page, VIEWPORT.width, VIEWPORT.height),
                );

                // The newest undo step is still the note's creation.
                exitStandMode();
                await act(async () => {
                    await store.undoLast();
                });
                expect(store.getPage(0).size).toBe(0);
                expect(store.canUndo).toBe(false);
            });
        }
    }
});
