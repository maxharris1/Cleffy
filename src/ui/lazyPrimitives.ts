import { prefetchWhenIdle } from '@/lib/idlePrefetch';
import { lazyModule } from '@/ui/lazyModule';
import { toasterModule } from '@/ui/toast';

/** Base UI's Dialog and AlertDialog, in a chunk of their own, for ui/Dialog. */
export const dialogPanelModule = lazyModule(() => import('@/ui/DialogPanel'));

/** Base UI's Menu, in a chunk of its own, for ui/Menu. */
export const menuBaseModule = lazyModule(() => import('@/ui/MenuBase'));

/** What a dialog or a menu is opened from. */
const TRIGGER_SELECTOR = 'button, [role="button"], [role="menuitem"]';
const INTENT_EVENTS = ['pointerover', 'focusin'] as const;

const prefetchPrimitives = () => {
    dialogPanelModule.prefetch();
    menuBaseModule.prefetch();
    toasterModule.prefetch();
};

/**
 * Warm the lazy dialog and menu chunks (ui/DialogPanel, ui/MenuBase), and the
 * toast stack's (ui/AppToaster), before anyone opens one or a toast fires:
 * when the page goes idle after its first render, or as soon as a pointer
 * comes over (or focus lands on) a button, whichever is first. A
 * first open then renders straight away, as it did when Base UI was in the
 * shell bundle, without that bundle having to carry it to the first paint.
 *
 * The service worker precaches these chunks anyway, so warming them costs no
 * extra download; a prefetch that fails is dropped, and the open that needs
 * the chunk imports it again itself.
 */
export const installPrimitivesPrefetch = (target: Document = document): (() => void) => {
    prefetchWhenIdle('ui-primitives', async () => prefetchPrimitives());

    const stop = () => {
        for (const type of INTENT_EVENTS) {
            target.removeEventListener(type, onIntent, true);
        }
    };
    const onIntent = (event: Event) => {
        if (event.target instanceof Element && event.target.closest(TRIGGER_SELECTOR)) {
            stop();
            prefetchPrimitives();
        }
    };
    for (const type of INTENT_EVENTS) {
        target.addEventListener(type, onIntent, { capture: true, passive: true });
    }
    return stop;
};
