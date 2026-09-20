/**
 * Demultiplexes pointer/wheel/Safari-gesture input on the viewer surface.
 *
 * Policy (plan §canvas/input): the surface has `touch-action: none`, so all
 * navigation is implemented here — one finger pans, two fingers pinch-zoom,
 * wheel scrolls, Ctrl/Cmd+wheel and trackpad pinch zoom. Pen pointers are
 * routed to the ink delegate (M2); while no delegate claims them they pan.
 * Touch is never inked: pen-vs-touch discrimination is the palm rejection.
 */

export interface GestureCallbacks {
    /** Pointer moved while panning; deltas in viewport CSS px. */
    onPan: (dx: number, dy: number) => void;
    /** Zoom to `scaleFactor` (relative multiplier) anchored at local viewport coords. */
    onZoomBy: (factor: number, centerX: number, centerY: number) => void;
    /** Wheel scroll deltas (already sign-adjusted: positive = scroll down/right). */
    onWheelScroll: (dx: number, dy: number) => void;
    /** A navigation gesture (pan/pinch) ended — commit crisp re-render, inertia, etc. */
    onGestureEnd: () => void;
    /**
     * A single non-ink primary-button pointer went down and up without moving
     * (tap/click) — local viewport coords. Used for edge-tap page turns and
     * tap-a-measure-to-seek during playback.
     */
    onTap?: (x: number, y: number, pointerType: string) => void;
}

/** Tap thresholds: total movement and press duration. */
const TAP_MAX_DIST_PX = 8;
const TAP_MAX_MS = 350;

export interface InkDelegate {
    /** Return true to claim the pointer for inking (checked on pointerdown). */
    shouldInk: (e: PointerEvent) => boolean;
    onInkDown: (e: PointerEvent) => void;
    onInkMove: (e: PointerEvent) => void;
    onInkUp: (e: PointerEvent) => void;
    onInkCancel: (e: PointerEvent) => void;
    /**
     * A two-finger pinch step (distance ratio). Return true to claim it — the
     * pinch then scales what the ink layer has selected instead of zooming
     * the page, until `onPinchEnd`.
     */
    onPinch?: (factor: number) => boolean;
    onPinchEnd?: () => void;
    /**
     * True when a second finger should steal the in-flight ink pointer and
     * become a pinch (text-tool resize with Finger-draw on).
     */
    canPinch?: () => boolean;
}

interface TrackedPointer {
    id: number;
    x: number;
    y: number;
    type: string;
    downX: number;
    downY: number;
    downAt: number;
    maxDist: number;
    /** True once this pointer ever shared the surface with another (pinch). */
    multi: boolean;
    /** Mouse button that started it (0 = primary); only primary taps count. */
    button: number;
}

/** Safari-proprietary gesture events (desktop trackpad pinch). */
interface SafariGestureEvent extends Event {
    scale: number;
    clientX: number;
    clientY: number;
}

/** How recently a pen must have been active for touches to be palm-rejected (ms). */
const PALM_REJECTION_WINDOW_MS = 500;

/** A Safari gesture starting this soon after a touch-down is an iOS pinch, not a trackpad. */
const TOUCH_PINCH_WINDOW_MS = 1000;

export class GestureController {
    private el: HTMLElement;
    private callbacks: GestureCallbacks;
    private inkDelegate: InkDelegate | null = null;

    private pointers = new Map<number, TrackedPointer>();
    private inkPointerId: number | null = null;
    private inkX = 0;
    private inkY = 0;
    private inkType = '';
    private lastPenActivity = 0;
    private lastTouchDown = 0;
    private lastSafariGestureScale = 1;
    /** A gesturestart has been seen and no gestureend yet. */
    private safariGestureActive = false;
    /** The active Safari gesture is an iOS touch pinch (pointer path owns it). */
    private touchPinch = false;
    private navigating = false;
    /** The ink delegate claimed the current two-finger pinch (scaling a selection). */
    private inkPinch = false;

    constructor(el: HTMLElement, callbacks: GestureCallbacks) {
        this.el = el;
        this.callbacks = callbacks;
        el.addEventListener('pointerdown', this.onPointerDown);
        el.addEventListener('pointermove', this.onPointerMove);
        el.addEventListener('pointerup', this.onPointerUp);
        el.addEventListener('pointercancel', this.onPointerCancel);
        el.addEventListener('wheel', this.onWheel, { passive: false });
        el.addEventListener('gesturestart', this.onSafariGestureStart as EventListener, { passive: false });
        el.addEventListener('gesturechange', this.onSafariGestureChange as EventListener, { passive: false });
        el.addEventListener('gestureend', this.onSafariGestureEnd as EventListener, { passive: false });
        // Suppress context menu on long-press / right-click over the score.
        el.addEventListener('contextmenu', this.onContextMenu);
    }

    destroy(): void {
        const el = this.el;
        el.removeEventListener('pointerdown', this.onPointerDown);
        el.removeEventListener('pointermove', this.onPointerMove);
        el.removeEventListener('pointerup', this.onPointerUp);
        el.removeEventListener('pointercancel', this.onPointerCancel);
        el.removeEventListener('wheel', this.onWheel);
        el.removeEventListener('gesturestart', this.onSafariGestureStart as EventListener);
        el.removeEventListener('gesturechange', this.onSafariGestureChange as EventListener);
        el.removeEventListener('gestureend', this.onSafariGestureEnd as EventListener);
        el.removeEventListener('contextmenu', this.onContextMenu);
        this.pointers.clear();
    }

    setInkDelegate(delegate: InkDelegate | null): void {
        this.inkDelegate = delegate;
    }

    private toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = this.el.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private onContextMenu = (e: Event): void => {
        e.preventDefault();
    };

    private onPointerDown = (e: PointerEvent): void => {
        // Never claim pointers that start on UI overlays (toolbar, zoom buttons,
        // text editor) — capturing them would swallow their click events.
        if (e.target instanceof Element && e.target.closest('[data-ui-overlay]')) {
            return;
        }
        try {
            this.el.setPointerCapture(e.pointerId);
        } catch {
            // A pointer cancelled mid-flight (rotation, system gesture) is gone
            // by the time this runs; tracking it without capture is still fine.
        }

        if (e.pointerType === 'pen') {
            this.lastPenActivity = performance.now();
        }
        if (e.pointerType === 'touch') {
            this.lastTouchDown = performance.now();
        }
        // Palm rejection: ignore touches that land while/just after the pen is
        // active. Finger-draw is the exception: a second finger on the text
        // tool promotes the ink pointer into a pinch-resize.
        if (e.pointerType === 'touch' && this.inkPointerId !== null) {
            if (this.inkType === 'touch' && this.inkDelegate?.canPinch?.()) {
                this.promoteInkToPinch(e);
            }
            return;
        }
        if (e.pointerType === 'touch' && performance.now() - this.lastPenActivity < PALM_REJECTION_WINDOW_MS) {
            return;
        }

        if (this.inkDelegate && this.inkPointerId === null && this.inkDelegate.shouldInk(e)) {
            const { x, y } = this.toLocal(e);
            this.inkPointerId = e.pointerId;
            this.inkX = x;
            this.inkY = y;
            this.inkType = e.pointerType;
            this.inkDelegate.onInkDown(e);
            return;
        }

        const { x, y } = this.toLocal(e);
        this.pointers.set(e.pointerId, {
            id: e.pointerId,
            x,
            y,
            type: e.pointerType,
            downX: x,
            downY: y,
            downAt: performance.now(),
            maxDist: 0,
            multi: this.pointers.size > 0,
            button: e.button,
        });
        if (this.pointers.size > 1) {
            for (const pointer of this.pointers.values()) {
                pointer.multi = true;
            }
        }
        this.navigating = true;
    };

    private onPointerMove = (e: PointerEvent): void => {
        if (e.pointerId === this.inkPointerId) {
            this.lastPenActivity = performance.now();
            const { x, y } = this.toLocal(e);
            this.inkX = x;
            this.inkY = y;
            this.inkDelegate?.onInkMove(e);
            return;
        }

        const tracked = this.pointers.get(e.pointerId);
        if (!tracked) {
            return;
        }
        const { x, y } = this.toLocal(e);

        if (this.pointers.size === 2 && tracked.type === 'touch') {
            // Pinch: zoom by the distance ratio, pan by the centroid delta.
            const other = [...this.pointers.values()].find((p) => p.id !== e.pointerId);
            if (other) {
                const prevDist = Math.hypot(tracked.x - other.x, tracked.y - other.y);
                const nextDist = Math.hypot(x - other.x, y - other.y);
                const centerX = (x + other.x) / 2;
                const centerY = (y + other.y) / 2;
                const prevCenterX = (tracked.x + other.x) / 2;
                const prevCenterY = (tracked.y + other.y) / 2;
                if (prevDist > 0 && nextDist > 0) {
                    const factor = nextDist / prevDist;
                    // The ink layer may claim the pinch (scaling a selected
                    // note); once claimed it keeps the whole gesture.
                    if (this.inkDelegate?.onPinch?.(factor)) {
                        this.inkPinch = true;
                    } else if (!this.inkPinch) {
                        this.callbacks.onZoomBy(factor, centerX, centerY);
                    }
                }
                if (!this.inkPinch) {
                    this.callbacks.onPan(centerX - prevCenterX, centerY - prevCenterY);
                }
            }
        } else if (this.pointers.size === 1) {
            // Mouse pans only while a button is held.
            if (tracked.type !== 'mouse' || e.buttons !== 0) {
                this.callbacks.onPan(x - tracked.x, y - tracked.y);
            }
        }

        tracked.x = x;
        tracked.y = y;
        tracked.maxDist = Math.max(tracked.maxDist, Math.hypot(x - tracked.downX, y - tracked.downY));
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (e.pointerId === this.inkPointerId) {
            this.inkPointerId = null;
            this.lastPenActivity = performance.now();
            this.inkDelegate?.onInkUp(e);
            return;
        }
        const tracked = this.pointers.get(e.pointerId);
        this.pointers.delete(e.pointerId);
        this.endInkPinchIfDone();
        if (
            tracked &&
            !tracked.multi &&
            tracked.button === 0 &&
            this.pointers.size === 0 &&
            tracked.maxDist < TAP_MAX_DIST_PX &&
            performance.now() - tracked.downAt < TAP_MAX_MS
        ) {
            this.callbacks.onTap?.(tracked.x, tracked.y, tracked.type);
        }
        if (this.pointers.size === 0 && this.navigating) {
            this.navigating = false;
            this.callbacks.onGestureEnd();
        }
    };

    private onPointerCancel = (e: PointerEvent): void => {
        if (e.pointerId === this.inkPointerId) {
            this.inkPointerId = null;
            this.inkDelegate?.onInkCancel(e);
            return;
        }
        this.pointers.delete(e.pointerId);
        this.endInkPinchIfDone();
        if (this.pointers.size === 0 && this.navigating) {
            this.navigating = false;
            this.callbacks.onGestureEnd();
        }
    };

    /**
     * Finger-draw claimed the first touch as ink; a second finger on a selected
     * note becomes pinch-resize instead of a one-finger pan + rejected palm.
     */
    private promoteInkToPinch(e: PointerEvent): void {
        const inkId = this.inkPointerId;
        if (inkId === null) {
            return;
        }
        this.inkDelegate?.onInkCancel(e);
        this.inkPointerId = null;
        const now = performance.now();
        this.pointers.set(inkId, {
            id: inkId,
            x: this.inkX,
            y: this.inkY,
            type: this.inkType,
            downX: this.inkX,
            downY: this.inkY,
            downAt: now,
            maxDist: 0,
            multi: true,
            button: 0,
        });
        const { x, y } = this.toLocal(e);
        this.pointers.set(e.pointerId, {
            id: e.pointerId,
            x,
            y,
            type: e.pointerType,
            downX: x,
            downY: y,
            downAt: now,
            maxDist: 0,
            multi: true,
            button: e.button,
        });
        this.navigating = true;
    }

    /** A claimed pinch ends as soon as fewer than two fingers remain. */
    private endInkPinchIfDone(): void {
        if (this.inkPinch && this.pointers.size < 2) {
            this.inkPinch = false;
            this.inkDelegate?.onPinchEnd?.();
        }
    }

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const { x, y } = this.toLocal(e);
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+wheel is also how Chrome/Firefox deliver trackpad pinch.
            this.callbacks.onZoomBy(Math.exp(-e.deltaY * 0.01), x, y);
            this.callbacks.onGestureEnd();
        } else {
            this.callbacks.onWheelScroll(e.deltaX, e.deltaY);
            this.callbacks.onGestureEnd();
        }
    };

    // Desktop Safari trackpad pinch arrives ONLY as gesture events. On iOS the
    // same events fire alongside touch pointers — there we only preventDefault
    // (the pointer path already handles the pinch) to suppress page zoom.
    // Which kind it is gets decided once, at gesturestart: a rotation or
    // system gesture can cancel the touch pointers mid-pinch, and the gesture
    // stream must not then fall through to the trackpad math with a stale
    // scale (one such event can jump the zoom to its maximum).
    private onSafariGestureStart = (e: SafariGestureEvent): void => {
        e.preventDefault();
        this.lastSafariGestureScale = e.scale;
        this.safariGestureActive = true;
        this.touchPinch = this.pointers.size > 0 || performance.now() - this.lastTouchDown < TOUCH_PINCH_WINDOW_MS;
    };

    private onSafariGestureChange = (e: SafariGestureEvent): void => {
        e.preventDefault();
        if (!this.safariGestureActive || this.touchPinch || this.pointers.size > 0) {
            return;
        }
        const factor = e.scale / this.lastSafariGestureScale;
        this.lastSafariGestureScale = e.scale;
        const { x, y } = this.toLocal(e);
        this.callbacks.onZoomBy(factor, x, y);
    };

    private onSafariGestureEnd = (e: SafariGestureEvent): void => {
        e.preventDefault();
        this.lastSafariGestureScale = 1;
        this.safariGestureActive = false;
        this.touchPinch = false;
        if (this.pointers.size === 0) {
            this.callbacks.onGestureEnd();
        }
    };
}
