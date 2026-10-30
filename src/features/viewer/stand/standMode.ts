import { useEffect } from 'react';

import { useViewerStore } from '@/state/store';
import type { Tool } from '@/types/models';

/**
 * Stand mode: the score alone, one whole page at a time, for playing from a
 * music stand. A tap on either side turns the page, a tap in the middle shows
 * a few controls for a moment, and the pedal keys turn pages as they always
 * do. Full screen through the Fullscreen API where there is one (prefixed on
 * older iPadOS); where there is none (iPhone) the viewport covers the window
 * as a fixed overlay 100dvh tall, which is as much as Safari gives a page.
 */

/** Fraction of the viewport's width, at either side, whose tap turns the page. */
export const STAND_EDGE_FRACTION = 0.35;

/** How long (ms) the controls a middle tap brings up stay on screen. */
export const STAND_MENU_MS = 3000;

export type StandTapZone = 'previous' | 'next' | 'menu';

/** What a tap at `x` px across a viewport `width` px wide does. */
export const standTapZone = (x: number, width: number): StandTapZone => {
    if (x < width * STAND_EDGE_FRACTION) {
        return 'previous';
    }
    if (x > width * (1 - STAND_EDGE_FRACTION)) {
        return 'next';
    }
    return 'menu';
};

export type StandKeyAction = 'previous' | 'next' | 'exit';

/**
 * What a key does in stand mode. Next: ArrowRight, PageDown, Space (and
 * ArrowDown); previous: ArrowLeft, PageUp, Shift+Space (and ArrowUp) — every
 * mode a Bluetooth page-turn pedal ships in. Escape leaves. Anything with a
 * modifier belongs to the browser.
 */
export const standKeyAction = (
    e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): StandKeyAction | null => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
        return null;
    }
    switch (e.key) {
        case 'Escape':
            return 'exit';
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
            return e.shiftKey ? null : 'next';
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
            return e.shiftKey ? null : 'previous';
        case ' ':
            return e.shiftKey ? 'previous' : 'next';
        default:
            return null;
    }
};

/** The page a turn lands on, or null at either end: stand mode never wraps. */
export const standPageAfter = (page: number, direction: -1 | 1, pageCount: number): number | null => {
    const next = page + direction;
    return next >= 0 && next < pageCount ? next : null;
};

/** What could make a page turn land in the middle of marking the score. */
export interface StandMarking {
    /** The ink layer holds a pointer: a stroke, an erase or a note drag is under way. */
    inking: boolean;
    /** A text note's editor is open. */
    editingText: boolean;
    /** A dialog is open over the viewer. */
    dialogOpen: boolean;
}

/** Page turns wait while the reader is marking the score: a turn mid-stroke would move the page under the pen. */
export const standTurnAllowed = ({ inking, editingText, dialogOpen }: StandMarking): boolean =>
    !inking && !editingText && !dialogOpen;

/** Tools that mark the score. In stand mode only a pen (Apple Pencil) uses them. */
const STAND_INK_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['pen', 'highlighter', 'eraser']);

/**
 * Whether a pointer may ink in stand mode at all (the ink layer still decides
 * whether it does). On the stand a finger or a click turns pages, whatever
 * the tool and the finger-draw setting; a pen keeps writing with the pen,
 * highlighter and eraser. The text and fingering tools need the chrome stand
 * mode hides, so nothing starts them there.
 */
export const standMayInk = (pointerType: string, tool: Tool): boolean =>
    pointerType === 'pen' && STAND_INK_TOOLS.has(tool);

// ---------------------------------------------------------------------------
// Fullscreen API, with the webkit prefix older iPadOS Safari still needs.

type PrefixedDocument = Document & {
    webkitFullscreenElement?: Element | null;
    webkitFullscreenEnabled?: boolean;
    webkitExitFullscreen?: () => Promise<void> | void;
};

type PrefixedElement = HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
};

const prefixed = (): PrefixedDocument => document as PrefixedDocument;

/** The element shown full screen, if any. */
export const fullscreenElement = (): Element | null =>
    prefixed().fullscreenElement ?? prefixed().webkitFullscreenElement ?? null;

/** Whether this browser can show an element full screen (iPhone Safari cannot). */
export const fullscreenSupported = (): boolean => {
    const doc = prefixed();
    return Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled);
};

/** The events that say an element entered or left full screen. */
export const FULLSCREEN_CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

/**
 * Ask for `el` full screen. Must run inside the click (or key) handler that
 * asked: browsers refuse it without a user gesture. A refusal is not an
 * error — the fixed overlay is the fallback.
 */
const requestFullscreen = (el: HTMLElement): void => {
    const target = el as PrefixedElement;
    try {
        const result = target.requestFullscreen
            ? target.requestFullscreen({ navigationUI: 'hide' })
            : target.webkitRequestFullscreen?.();
        void Promise.resolve(result).catch(() => undefined);
    } catch {
        // Refused synchronously (older WebKit): the overlay covers the window.
    }
};

const leaveFullscreen = (): void => {
    if (!fullscreenElement()) {
        return;
    }
    const doc = prefixed();
    try {
        const result = doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.();
        void Promise.resolve(result).catch(() => undefined);
    } catch {
        // Already leaving.
    }
};

// ---------------------------------------------------------------------------
// Entering and leaving.

/** The viewport stand mode shows full screen (PdfViewport registers it while mounted). */
let standTarget: HTMLElement | null = null;

/** PdfViewport's container, or null as it unmounts. */
export const setStandTarget = (el: HTMLElement | null): void => {
    standTarget = el;
};

/** Enter stand mode. Call from the click (or key) handler, so full screen is allowed. */
export const enterStandMode = (): void => {
    if (!standTarget || useViewerStore.getState().standMode) {
        return;
    }
    if (fullscreenSupported()) {
        requestFullscreen(standTarget);
    }
    useViewerStore.getState().setStandMode(true);
};

/** Leave stand mode, and full screen with it. */
export const exitStandMode = (): void => {
    if (!useViewerStore.getState().standMode) {
        return;
    }
    leaveFullscreen();
    useViewerStore.getState().setStandMode(false);
};

// ---------------------------------------------------------------------------
// While it lasts.

/**
 * What stand mode holds while `active`:
 *  - a screen wake lock, so the screen stays on through a piece. The browser
 *    drops it whenever the page is hidden, so it is asked for again on coming
 *    back. Without the API (or with it refused: battery saver, an iframe) the
 *    screen sleeps as usual.
 *  - the mode itself, for as long as the score is full screen: leaving full
 *    screen the browser's way (Escape, which the page never sees, or the
 *    system's gesture) leaves stand mode too.
 */
export const useStandSession = (active: boolean): void => {
    useEffect(() => {
        if (!active) {
            return;
        }
        let wasFullscreen = fullscreenElement() !== null;
        const onFullscreenChange = () => {
            if (fullscreenElement()) {
                wasFullscreen = true;
            } else if (wasFullscreen) {
                exitStandMode();
            }
        };
        for (const type of FULLSCREEN_CHANGE_EVENTS) {
            document.addEventListener(type, onFullscreenChange);
        }
        return () => {
            for (const type of FULLSCREEN_CHANGE_EVENTS) {
                document.removeEventListener(type, onFullscreenChange);
            }
        };
    }, [active]);

    useEffect(() => {
        if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
            return;
        }
        let released = false;
        let sentinel: WakeLockSentinel | null = null;
        const acquire = () => {
            if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) {
                return;
            }
            navigator.wakeLock
                .request('screen')
                .then((lock) => {
                    if (released) {
                        void lock.release().catch(() => undefined);
                        return;
                    }
                    sentinel = lock;
                })
                .catch(() => undefined);
        };
        acquire();
        document.addEventListener('visibilitychange', acquire);
        return () => {
            released = true;
            document.removeEventListener('visibilitychange', acquire);
            void sentinel?.release().catch(() => undefined);
            sentinel = null;
        };
    }, [active]);
};
