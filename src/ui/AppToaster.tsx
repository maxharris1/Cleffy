import { Toaster } from 'sonner';
// Sonner also injects these from JS, as an inline style element the CSP
// (style-src 'self') refuses; the build strips that injection
// (vite.config.ts, sonner-styles) and this same-origin sheet stands in. It is
// imported here, not in main.tsx, so it arrives with this lazy chunk rather
// than weighing on every first paint.
import 'sonner/dist/styles.css';

import { useMediaQuery } from '@/lib/useMediaQuery';

/** Below Tailwind's sm: the phone layout, whose toolbar sits along the bottom edge. */
const PHONE = '(max-width: 39.99rem)';

/**
 * Clear of the top bar on a phone: the safe-area inset plus the height of a
 * one-row header (the viewer's, and the library's brand row).
 */
const BELOW_HEADER = 'calc(var(--safe-top) + 3.5rem)';
/** Above the home indicator, with the same breathing room Sonner gives by default. */
const ABOVE_HOME_INDICATOR = 'calc(var(--safe-bottom) + 1.5rem)';
const SIDE = { left: 'max(1rem, var(--safe-left))', right: 'max(1rem, var(--safe-right))' };

/**
 * The one toast stack (ui/toast fires into it). Bottom-centre from sm up:
 * on an iPad the toolbar is top-centre, the pager bottom-left and the zoom
 * bottom-right, so the middle of the bottom edge is the clear lane — and it
 * keeps toasts out from under a right-handed writer's palm. On a phone the
 * toolbar has the bottom edge, so toasts drop from the top, below the header.
 *
 * Sonner keeps its own enter and exit (a 400ms slide and fade, tuned to the
 * component), and swipe-to-dismiss follows the position. richColors is off:
 * the toasts wear the app's paper and ink, through classNames rather than a
 * second set of colours.
 */
export const AppToaster = () => {
    const phone = useMediaQuery(PHONE);
    return (
        <Toaster
            position={phone ? 'top-center' : 'bottom-center'}
            offset={{ top: BELOW_HEADER, bottom: ABOVE_HOME_INDICATOR, ...SIDE }}
            mobileOffset={{ top: BELOW_HEADER, bottom: ABOVE_HOME_INDICATOR, ...SIDE }}
            theme="light"
            toastOptions={{
                classNames: {
                    toast: '!rounded-xl !border-stone-200 !bg-white !font-sans !text-ink !shadow-lg',
                    title: '!text-sm !font-medium',
                    description: '!text-ink-muted',
                    success: '[&_[data-icon]]:text-ok',
                    error: '[&_[data-icon]]:text-danger',
                },
            }}
        />
    );
};
