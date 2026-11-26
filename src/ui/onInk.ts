import { createContext, useContext } from 'react';

import type { ButtonVariant } from '@/ui/classNames';

/**
 * True inside an ink surface (the viewer header). Controls that also appear on
 * paper, such as the Export menu, read it to pick their on-ink look.
 */
export const OnInkContext = createContext(false);

export const useGhostVariant = (): ButtonVariant => (useContext(OnInkContext) ? 'inkGhost' : 'ghost');
