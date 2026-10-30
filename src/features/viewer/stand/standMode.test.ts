import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    enterStandMode,
    exitStandMode,
    setStandTarget,
    STAND_EDGE_FRACTION,
    standKeyAction,
    standMayInk,
    standPageAfter,
    standTapZone,
    standTurnAllowed,
    useStandSession,
} from '@/features/viewer/stand/standMode';
import { useViewerStore } from '@/state/store';

const key = (k: string, mods: Partial<Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>> = {}) =>
    standKeyAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('standTapZone', () => {
    it('turns back on the left ~35%, forward on the right ~35%, and opens the controls between', () => {
        expect(STAND_EDGE_FRACTION).toBe(0.35);
        expect(standTapZone(0, 1000)).toBe('previous');
        expect(standTapZone(349, 1000)).toBe('previous');
        expect(standTapZone(350, 1000)).toBe('menu');
        expect(standTapZone(500, 1000)).toBe('menu');
        expect(standTapZone(650, 1000)).toBe('menu');
        expect(standTapZone(651, 1000)).toBe('next');
        expect(standTapZone(999, 1000)).toBe('next');
    });
});

describe('standKeyAction', () => {
    it('turns forward on ArrowRight, PageDown and Space (page-turn pedals)', () => {
        expect(key('ArrowRight')).toBe('next');
        expect(key('PageDown')).toBe('next');
        expect(key(' ')).toBe('next');
        expect(key('ArrowDown')).toBe('next');
    });

    it('turns back on ArrowLeft, PageUp and Shift+Space', () => {
        expect(key('ArrowLeft')).toBe('previous');
        expect(key('PageUp')).toBe('previous');
        expect(key(' ', { shiftKey: true })).toBe('previous');
        expect(key('ArrowUp')).toBe('previous');
    });

    it('leaves on Escape', () => {
        expect(key('Escape')).toBe('exit');
    });

    it('leaves keys with a modifier, and any other key, to the browser', () => {
        expect(key('ArrowRight', { ctrlKey: true })).toBeNull();
        expect(key('ArrowLeft', { metaKey: true })).toBeNull();
        expect(key(' ', { altKey: true })).toBeNull();
        expect(key('ArrowRight', { shiftKey: true })).toBeNull();
        expect(key('Enter')).toBeNull();
        expect(key('a')).toBeNull();
    });
});

describe('standPageAfter', () => {
    it('steps one page either way', () => {
        expect(standPageAfter(0, 1, 3)).toBe(1);
        expect(standPageAfter(2, -1, 3)).toBe(1);
    });

    it('never wraps at the first or last page', () => {
        expect(standPageAfter(0, -1, 3)).toBeNull();
        expect(standPageAfter(2, 1, 3)).toBeNull();
        expect(standPageAfter(0, 1, 1)).toBeNull();
        expect(standPageAfter(0, -1, 1)).toBeNull();
    });
});

describe('standTurnAllowed', () => {
    const idle = { inking: false, editingText: false, dialogOpen: false };

    it('turns when nothing is being marked', () => {
        expect(standTurnAllowed(idle)).toBe(true);
    });

    it('holds the page while a stroke is under way, a note is being typed, or a dialog is open', () => {
        expect(standTurnAllowed({ ...idle, inking: true })).toBe(false);
        expect(standTurnAllowed({ ...idle, editingText: true })).toBe(false);
        expect(standTurnAllowed({ ...idle, dialogOpen: true })).toBe(false);
    });
});

describe('standMayInk', () => {
    it('lets a pen write, mark and erase', () => {
        expect(standMayInk('pen', 'pen')).toBe(true);
        expect(standMayInk('pen', 'highlighter')).toBe(true);
        expect(standMayInk('pen', 'eraser')).toBe(true);
    });

    it('keeps fingers and the mouse for turning pages, whatever the tool', () => {
        for (const pointer of ['touch', 'mouse']) {
            expect(standMayInk(pointer, 'pen')).toBe(false);
            expect(standMayInk(pointer, 'highlighter')).toBe(false);
            expect(standMayInk(pointer, 'eraser')).toBe(false);
        }
    });

    it('starts nothing that needs the hidden chrome', () => {
        expect(standMayInk('pen', 'text')).toBe(false);
        expect(standMayInk('pen', 'fingering')).toBe(false);
        expect(standMayInk('pen', 'pan')).toBe(false);
    });
});

describe('entering and leaving', () => {
    type FullscreenDoc = {
        fullscreenEnabled?: boolean;
        fullscreenElement?: Element | null;
        exitFullscreen?: () => Promise<void>;
        webkitFullscreenEnabled?: boolean;
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => void;
    };
    const doc = document as unknown as FullscreenDoc;
    let target: HTMLElement & { webkitRequestFullscreen?: () => void };

    beforeEach(() => {
        target = document.createElement('div');
        document.body.append(target);
        setStandTarget(target);
    });

    afterEach(() => {
        exitStandMode();
        setStandTarget(null);
        target.remove();
        for (const prop of [
            'fullscreenEnabled',
            'fullscreenElement',
            'exitFullscreen',
            'webkitFullscreenEnabled',
            'webkitFullscreenElement',
            'webkitExitFullscreen',
        ] as const) {
            delete doc[prop];
        }
        vi.restoreAllMocks();
    });

    it('asks for the score full screen, inside the click', () => {
        doc.fullscreenEnabled = true;
        const request = vi.fn(() => Promise.resolve());
        target.requestFullscreen = request;
        enterStandMode();
        expect(request).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().standMode).toBe(true);
    });

    it('uses the webkit prefix where that is all there is (older iPadOS Safari)', () => {
        doc.webkitFullscreenEnabled = true;
        const request = vi.fn();
        target.webkitRequestFullscreen = request;
        enterStandMode();
        expect(request).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().standMode).toBe(true);

        const exit = vi.fn();
        doc.webkitFullscreenElement = target;
        doc.webkitExitFullscreen = exit;
        exitStandMode();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().standMode).toBe(false);
    });

    it('enters anyway without the Fullscreen API (iPhone): the overlay covers the window', () => {
        const request = vi.fn(() => Promise.resolve());
        target.requestFullscreen = request;
        enterStandMode();
        expect(request).not.toHaveBeenCalled();
        expect(useViewerStore.getState().standMode).toBe(true);
    });

    it('enters anyway when full screen is refused', async () => {
        doc.fullscreenEnabled = true;
        target.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'));
        enterStandMode();
        await Promise.resolve();
        expect(useViewerStore.getState().standMode).toBe(true);
    });

    it('leaves full screen with the mode', () => {
        doc.fullscreenEnabled = true;
        target.requestFullscreen = () => Promise.resolve();
        enterStandMode();
        const exit = vi.fn(() => Promise.resolve());
        doc.fullscreenElement = target;
        doc.exitFullscreen = exit;
        exitStandMode();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().standMode).toBe(false);
    });

    it('does nothing with no score to show', () => {
        setStandTarget(null);
        enterStandMode();
        expect(useViewerStore.getState().standMode).toBe(false);
    });
});

describe('useStandSession', () => {
    afterEach(() => {
        cleanup();
        exitStandMode();
        delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
        vi.unstubAllGlobals();
    });

    const stubWakeLock = (request: () => Promise<unknown>) =>
        vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { wakeLock: { request: vi.fn(request) } }));

    it('holds a screen wake lock while active and releases it after', async () => {
        const release = vi.fn(() => Promise.resolve());
        stubWakeLock(() => Promise.resolve({ released: false, release }));
        const { rerender } = renderHook(({ active }) => useStandSession(active), { initialProps: { active: true } });
        expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
        await Promise.resolve();
        rerender({ active: false });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases a lock that arrives after the mode ended', async () => {
        const release = vi.fn(() => Promise.resolve());
        let grant: (lock: unknown) => void = () => undefined;
        stubWakeLock(() => new Promise((resolve) => (grant = resolve)));
        const { unmount } = renderHook(() => useStandSession(true));
        unmount();
        grant({ released: false, release });
        await Promise.resolve();
        await Promise.resolve();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('carries on without a wake lock where it is refused or missing', async () => {
        stubWakeLock(() => Promise.reject(new DOMException('Not allowed', 'NotAllowedError')));
        const { unmount } = renderHook(() => useStandSession(true));
        await Promise.resolve();
        unmount();
        vi.unstubAllGlobals();
        expect(() => renderHook(() => useStandSession(true)).unmount()).not.toThrow();
    });

    it('ends stand mode when the score leaves full screen the browser’s way (Escape)', () => {
        const doc = document as { fullscreenElement?: Element | null };
        useViewerStore.getState().setStandMode(true);
        renderHook(() => useStandSession(true));
        doc.fullscreenElement = document.body;
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(useViewerStore.getState().standMode).toBe(true);
        doc.fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(useViewerStore.getState().standMode).toBe(false);
    });

    it('stays in the overlay when full screen never started', () => {
        useViewerStore.getState().setStandMode(true);
        renderHook(() => useStandSession(true));
        document.dispatchEvent(new Event('webkitfullscreenchange'));
        expect(useViewerStore.getState().standMode).toBe(true);
    });
});
