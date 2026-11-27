import { createContext, useContext } from 'react';

import { buttonClassName, type ButtonVariant } from '@/ui/classNames';

export const OnInkContext = createContext(false);

/** Flow-Viewer's desktop type for the text actions in the ink header. */
export const INK_TEXT_ACTION = 'lg:text-[15px] lg:font-medium';

export const useGhostVariant = (): ButtonVariant => (useContext(OnInkContext) ? 'inkGhost' : 'ghost');

/** A small ghost text action, in the header's desktop type when it sits on ink. */
export const useGhostActionClassName = (extra = ''): string => {
    const onInk = useContext(OnInkContext);
    return buttonClassName(
        onInk ? 'inkGhost' : 'ghost',
        'sm',
        [onInk ? INK_TEXT_ACTION : '', extra].filter(Boolean).join(' '),
    );
};
