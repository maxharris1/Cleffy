import { lazy, Suspense, useSyncExternalStore } from 'react';

import { hasSignedOutInk, subscribeSignedOutInk } from '@/sync/inkRecoverySignal';

// Lazy: it brings the export stack, and almost no session ever needs it.
const SignedOutInkNotice = lazy(() =>
    import('@/features/viewer/SignedOutInkNotice').then((m) => ({ default: m.SignedOutInkNotice })),
);

/**
 * The app-wide notice for unsaved ink a signed-out account left in this tab
 * (SignedOutInkNotice), loaded only once there is some. Renders nothing
 * otherwise.
 */
export const SignedOutInkGate = () => {
    const held = useSyncExternalStore(subscribeSignedOutInk, hasSignedOutInk);
    return held ? (
        <Suspense fallback={null}>
            <SignedOutInkNotice />
        </Suspense>
    ) : null;
};
