import { useLayoutEffect } from 'react';

import { trackPointerKinds } from '@/state/store';

/**
 * Records the kind of every pointer pressed anywhere on the page while mounted,
 * so a stylus used on a loading screen, before any score or header exists,
 * still counts once the score opens.
 */
export const useRecordPointerKinds = () => {
    useLayoutEffect(() => trackPointerKinds(document), []);
};
