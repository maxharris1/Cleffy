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
}

export interface InkDelegate {
    /** Return true to claim the pointer for inking (checked on pointerdown). */
    shouldInk: (e: PointerEvent) => boolean;
    onInkDown: (e: PointerEvent) => void;
    onInkMove: (e: PointerEvent) => void;
    onInkUp: (e: PointerEvent) => void;
    onInkCancel: (e: PointerEvent) => void;
}

interface TrackedPointer {
    id: number;
    x: number;
    y: number;
    type: string;
}

/** Safari-proprietary gesture events (desktop trackpad pinch). */
interface SafariGestureEvent extends Event {
    scale: number;
    clientX: number;
    clientY: number;
}

/** How recently a pen must have been active for touches to be palm-rejected (ms). */
const PALM_REJECTION_WINDOW_MS = 500;

export class GestureController {
    private el: HTMLElement;
    private callbacks: GestureCallbacks;
    private inkDelegate: InkDelegate | null = null;

    private pointers = new Map<number, TrackedPointer>();
    private inkPointerId: number | null = null;
    private lastPenActivity = 0;
    private lastSafariGestureScale = 1;
    private navigating = false;

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
        this.el.setPointerCapture(e.pointerId);

        if (e.pointerType === 'pen') {
            this.lastPenActivity = performance.now();
        }
        // Palm rejection: ignore touches that land while/just after the pen is active.
        if (
            e.pointerType === 'touch' &&
            (this.inkPointerId !== null || performance.now() - this.lastPenActivity < PALM_REJECTION_WINDOW_MS)
        ) {
            return;
        }

        if (this.inkDelegate && this.inkPointerId === null && this.inkDelegate.shouldInk(e)) {
            this.inkPointerId = e.pointerId;
            this.inkDelegate.onInkDown(e);
            return;
        }

        const { x, y } = this.toLocal(e);
        this.pointers.set(e.pointerId, { id: e.pointerId, x, y, type: e.pointerType });
        this.navigating = true;
    };

    private onPointerMove = (e: PointerEvent): void => {
        if (e.pointerId === this.inkPointerId) {
            this.lastPenActivity = performance.now();
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
                    this.callbacks.onZoomBy(nextDist / prevDist, centerX, centerY);
                }
                this.callbacks.onPan(centerX - prevCenterX, centerY - prevCenterY);
            }
        } else if (this.pointers.size === 1) {
            // Mouse pans only while a button is held.
            if (tracked.type !== 'mouse' || e.buttons !== 0) {
                this.callbacks.onPan(x - tracked.x, y - tracked.y);
            }
        }

        tracked.x = x;
        tracked.y = y;
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (e.pointerId === this.inkPointerId) {
            this.inkPointerId = null;
            this.lastPenActivity = performance.now();
            this.inkDelegate?.onInkUp(e);
            return;
        }
        this.pointers.delete(e.pointerId);
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
        if (this.pointers.size === 0 && this.navigating) {
            this.navigating = false;
            this.callbacks.onGestureEnd();
        }
    };

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
    private onSafariGestureStart = (e: SafariGestureEvent): void => {
        e.preventDefault();
        this.lastSafariGestureScale = e.scale;
    };

    private onSafariGestureChange = (e: SafariGestureEvent): void => {
        e.preventDefault();
        if (this.pointers.size > 0) {
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
        if (this.pointers.size === 0) {
            this.callbacks.onGestureEnd();
        }
    };
}
