import { setImmediate as queueInputTask } from 'node:timers';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRoutes as Routes } from '@/app/routes';
import type { DocumentLayout } from '@/features/viewer/geometry';
import type { GestureCallbacks } from '@/features/viewer/ink/GestureController';
import type { useViewerStore as ViewerStore } from '@/state/store';
import { useViewport } from '@/test/touchLayout';

/**
 * The /try and /doc loading screens, rendered through the real AppRoutes: the
 * router's own fallback while the lazy page import is held, then the page's
 * fallback while the score's bytes are on the way. The demo viewer is a stub
 * that mounts the real Toolbar, GestureController and InkController on a page
 * whose canvas records what it shows.
 */
const h = vi.hoisted(() => ({
    track: vi.fn(),
    releaseImport: (): void => undefined,
    importHeld: Promise.resolve(),
    resolveScore: null as ((bytes: ArrayBuffer) => void) | null,
    onPan: null as ReturnType<typeof vi.fn<GestureCallbacks['onPan']>> | null,
    shown: [] as string[],
    ready: false,
}));

vi.mock('@/lib/webEvents', () => ({ track: h.track }));

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false, lastEvent: null }),
    isRegisteredSession: () => false,
    userTypeOf: () => null,
    displayNameOf: () => '',
}));

vi.mock('@/features/demo/loadDemoScore', () => ({
    DemoScoreUnavailableError: class extends Error {},
    loadDemoScore: () =>
        new Promise<ArrayBuffer>((resolve) => {
            h.resolveScore = resolve;
        }),
}));

const PAGE_W = 1000;
const PAGE_H = 1300;

const layout: DocumentLayout = {
    layouts: [{ top: 0, left: 0, width: PAGE_W, height: PAGE_H }],
    contentWidth: PAGE_W,
    contentHeight: PAGE_H,
};

class FakePath2D {
    constructor(readonly d = '') {}
}

const demoViewerStub = async () => {
    const { useEffect, useRef, useState } = await import('react');
    const { AnnotationStore } = await import('@/sync/annotationStore');
    const { ScribblerDb } = await import('@/sync/db');
    const { CanvasRegistry } = await import('@/features/viewer/ink/CanvasRegistry');
    const { GestureController } = await import('@/features/viewer/ink/GestureController');
    const { InkController } = await import('@/features/viewer/ink/InkController');
    const { Toolbar } = await import('@/features/viewer/toolbar/Toolbar');

    const fakeCanvas = (shown: string[]) => {
        const ctx = {
            save: () => undefined,
            restore: () => undefined,
            clearRect: () => {
                shown.length = 0;
            },
            fill: (path: FakePath2D) => {
                shown.push(path.d);
            },
            fillStyle: '',
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
        };
        const events = new EventTarget();
        return {
            width: PAGE_W,
            height: PAGE_H,
            getContext: () => ctx,
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events),
        } as unknown as HTMLCanvasElement;
    };

    return {
        DemoViewer: () => {
            const ref = useRef<HTMLDivElement>(null);
            const [store] = useState(
                () => new AnnotationStore(new ScribblerDb(`demo-${crypto.randomUUID()}`), 'local-demo-v2'),
            );
            useEffect(() => {
                const el = ref.current!;
                el.setPointerCapture = () => undefined;
                const registry = new CanvasRegistry();
                registry.register(0, { committed: fakeCanvas(h.shown), live: fakeCanvas([]) });
                const ink = new InkController({
                    store,
                    registry,
                    isReadOnly: () => false,
                    getView: () => ({ scale: 1, scrollX: 0, scrollY: 0 }),
                    getLayout: () => layout,
                    toLocal: (e) => ({ x: e.clientX, y: e.clientY }),
                    onTextIntent: () => undefined,
                    onFingeringSelect: () => undefined,
                    panKeyHeld: () => false,
                });
                const onPan = vi.fn<GestureCallbacks['onPan']>();
                const gestures = new GestureController(el, {
                    onPan,
                    onZoomBy: () => undefined,
                    onWheelScroll: () => undefined,
                    onGestureEnd: () => undefined,
                });
                gestures.setInkDelegate(ink.delegate);
                h.onPan = onPan;
                let live = true;
                void store.load().then(() => {
                    if (live) {
                        h.ready = true;
                    }
                });
                return () => {
                    live = false;
                    h.ready = false;
                    gestures.destroy();
                    ink.destroy();
                };
            }, [store]);
            return (
                <div ref={ref} data-testid="viewport">
                    <Toolbar store={store} />
                </div>
            );
        },
    };
};

let AppRoutes: typeof Routes;
let useViewerStore: typeof ViewerStore;

let clock: number;
let nextPointerId = 1;

const fingerSwipe = (el: Element) => {
    const pointerId = nextPointerId++;
    const at = (type: string, x: number) =>
        new PointerEvent(type, { pointerId, pointerType: 'touch', clientX: x, clientY: 300, button: 0, bubbles: true });
    el.dispatchEvent(at('pointerdown', 100));
    el.dispatchEvent(at('pointermove', 140));
    el.dispatchEvent(at('pointermove', 180));
    el.dispatchEvent(at('pointerup', 180));
    clock += 1000;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const setFingerDraws = (fingerDraws: boolean) => {
    act(() => useViewerStore.getState().setFingerDraws(fingerDraws));
    expect(useViewerStore.getState().fingerDraws).toBe(fingerDraws);
};

const openScore = async () => {
    await waitFor(() => expect(h.resolveScore).not.toBeNull());
    act(() => h.resolveScore!(new ArrayBuffer(8)));
    const viewport = await screen.findByTestId('viewport');
    await waitFor(() => expect(h.ready).toBe(true));
    return viewport;
};

const holdImport = () => {
    h.importHeld = new Promise<void>((resolve) => {
        h.releaseImport = resolve;
    });
};

beforeEach(async () => {
    vi.resetModules();
    h.importHeld = Promise.resolve();
    vi.doMock('@/features/demo/DemoViewer', demoViewerStub);
    vi.doMock('@/features/demo/DemoPage', async (importOriginal) => {
        await h.importHeld;
        return importOriginal();
    });
    vi.doMock('@/features/viewer/ViewerPage', async () => {
        await h.importHeld;
        return { ViewerPage: () => <div>viewer-page</div> };
    });
    ({ AppRoutes } = await import('@/app/routes'));
    ({ useViewerStore } = await import('@/state/store'));
    clock = 10_000;
    h.resolveScore = null;
    h.onPan = null;
    h.shown = [];
    h.ready = false;
    window.sessionStorage.clear();
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    useViewport({ width: 1024, coarse: true });
    useViewerStore.setState({ tool: 'pen', penSeen: false, touchSeen: false });
});

afterEach(() => {
    cleanup();
    useViewerStore.setState({ penSeen: false, touchSeen: false, fingerDraws: false });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const renderAt = (path: string) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
        </MemoryRouter>,
    );

const renderTry = async () => {
    renderAt('/try');
    const loading = await screen.findByText('Loading demo…');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    return loading;
};

const penPress = (el: Element) => {
    fireEvent.pointerDown(el, { pointerType: 'pen' });
    fireEvent.pointerUp(el, { pointerType: 'pen' });
};

describe("/try, a pen pressed on the router's Loading demo… screen", () => {
    it.each([true, false])(
        'hides the Scroll | Draw switch and a finger drag scrolls without ink, Finger-draw %s',
        async (fingerDraws) => {
            holdImport();
            const loading = await renderTry();
            setFingerDraws(fingerDraws);

            penPress(loading);

            act(() => h.releaseImport());
            const viewport = await openScore();
            expect(useViewerStore.getState().penSeen).toBe(true);
            expect(screen.queryByRole('button', { name: 'Draw with finger' })).not.toBeInTheDocument();

            setFingerDraws(fingerDraws);
            fingerSwipe(viewport);
            await settle();
            expect(h.shown).toHaveLength(0);
            expect(h.onPan).toHaveBeenCalled();
        },
    );
});

describe("/doc, a pen pressed on the router's Loading viewer… screen", () => {
    it('counts once the viewer page mounts', async () => {
        holdImport();
        renderAt('/doc/local-score');
        const loading = await screen.findByText('Loading viewer…');

        penPress(loading);

        act(() => h.releaseImport());
        await screen.findByText('viewer-page');
        expect(useViewerStore.getState().penSeen).toBe(true);
    });
});

describe("/try, a pen pressed on the demo's own loading screen", () => {
    it.each([true, false])(
        'hides Draw with finger and a finger drag scrolls without ink, Finger-draw %s',
        async (fingerDraws) => {
            await renderTry();
            await waitFor(() => expect(h.resolveScore).not.toBeNull());
            const loading = screen.getByText('Loading demo…');
            setFingerDraws(fingerDraws);

            penPress(loading);
            expect(useViewerStore.getState().penSeen).toBe(true);

            const viewport = await openScore();
            expect(screen.queryByRole('group', { name: 'What a finger does' })).not.toBeInTheDocument();

            setFingerDraws(fingerDraws);
            fingerSwipe(viewport);
            await settle();
            expect(h.shown).toHaveLength(0);
            expect(h.onPan).toHaveBeenCalled();
        },
    );

    it('without a pen, shows the Scroll | Draw switch and a finger drag inks with it on', async () => {
        await renderTry();

        const viewport = await openScore();
        expect(screen.getByRole('group', { name: 'What a finger does' })).toBeInTheDocument();

        setFingerDraws(true);
        fingerSwipe(viewport);
        await settle();
        expect(h.shown).toHaveLength(1);
        expect(h.onPan).not.toHaveBeenCalled();
        expect(useViewerStore.getState().penSeen).toBe(false);
    });
});

describe("the first queued pen press on the router's loading screen, before passive effects run", () => {
    const pressOnceFallbackPaints = async (path: string, label: string) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
        const mount = document.body.appendChild(document.createElement('div'));
        const root = createRoot(mount);
        const pressed = new Promise<void>((resolve) => {
            const poll = () => {
                const fallback = mount.querySelector('main');
                if (fallback?.textContent !== label) {
                    queueInputTask(poll);
                    return;
                }
                fallback.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen', bubbles: true }));
                resolve();
            };
            queueInputTask(poll);
        });
        root.render(
            <MemoryRouter initialEntries={[path]}>
                <AppRoutes />
            </MemoryRouter>,
        );
        await pressed;
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        return () => {
            act(() => root.unmount());
            mount.remove();
        };
    };

    it('on /try, hides Draw with finger and a finger drag pans without ink', async () => {
        holdImport();
        setFingerDraws(true);
        const unmount = await pressOnceFallbackPaints('/try', 'Loading demo…');
        try {
            act(() => h.releaseImport());
            const viewport = await openScore();
            fingerSwipe(viewport);
            await settle();
            expect({
                penSeen: useViewerStore.getState().penSeen,
                switchVisible: screen.queryByRole('button', { name: 'Draw with finger' }) !== null,
                panned: h.onPan?.mock.calls.length !== 0,
                committed: h.shown.length,
            }).toEqual({ penSeen: true, switchVisible: false, panned: true, committed: 0 });
        } finally {
            unmount();
        }
    });

    it('on /doc, counts once the viewer page mounts', async () => {
        holdImport();
        const unmount = await pressOnceFallbackPaints('/doc/local-score', 'Loading viewer…');
        try {
            act(() => h.releaseImport());
            await screen.findByText('viewer-page');
            expect(useViewerStore.getState().penSeen).toBe(true);
        } finally {
            unmount();
        }
    });
});
