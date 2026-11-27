import { createContext, useContext } from 'react';

import { buttonClassName, type ButtonVariant } from '@/ui/classNames';

export const OnInkContext = createContext(false);

/** Flow-Viewer's and Flow-Phone-Viewer's type for the text actions in the ink header. */
export const INK_TEXT_ACTION = 'text-[15px]! font-medium!';

export const useGhostVariant = (): ButtonVariant => (useContext(OnInkContext) ? 'inkGhost' : 'ghost');

/** A small ghost text action, in the header's type when it sits on ink. */
export const useGhostActionClassName = (extra = ''): string => {
    const onInk = useContext(OnInkContext);
    return buttonClassName(
        onInk ? 'inkGhost' : 'ghost',
        'sm',
        [onInk ? INK_TEXT_ACTION : '', extra].filter(Boolean).join(' '),
    );
};
