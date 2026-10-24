import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefetchWhenIdle } from '@/lib/idlePrefetch';
import { dialogPanelModule, installPrimitivesPrefetch, menuBaseModule } from '@/ui/lazyPrimitives';

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('installPrimitivesPrefetch', () => {
    it('warms the dialog and menu chunks when the page goes idle', () => {
        const stop = installPrimitivesPrefetch();
        expect(prefetchWhenIdle).toHaveBeenCalledWith('ui-primitives', expect.any(Function));
        stop();
    });

    it('warms them on the first hover or focus of a button, once', () => {
        const dialog = vi.spyOn(dialogPanelModule, 'prefetch').mockImplementation(() => {});
        const menu = vi.spyOn(menuBaseModule, 'prefetch').mockImplementation(() => {});
        document.body.innerHTML = '<p>Text</p><button type="button"><span>Share</span></button>';
        const stop = installPrimitivesPrefetch();

        document.querySelector('p')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        expect(dialog).not.toHaveBeenCalled();

        // Over the button's icon or label counts as over the button.
        document.querySelector('span')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        expect(dialog).toHaveBeenCalledTimes(1);
        expect(menu).toHaveBeenCalledTimes(1);

        document.querySelector('button')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(dialog).toHaveBeenCalledTimes(1);
        stop();
    });
});
