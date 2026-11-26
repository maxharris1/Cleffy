import { createContext, useContext } from 'react';

import type { ButtonVariant } from '@/ui/classNames';

export const OnInkContext = createContext(false);

export const useGhostVariant = (): ButtonVariant => (useContext(OnInkContext) ? 'inkGhost' : 'ghost');
