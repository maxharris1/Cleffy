export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface InputState {
    touchScreen: boolean;
    touchSeen: boolean;
    penSeen: boolean;
    fingerDraws: boolean;
}

export const showFingerSwitch = ({
    touchScreen,
    touchSeen,
    penSeen,
}: Pick<InputState, 'touchScreen' | 'touchSeen' | 'penSeen'>): boolean => (touchScreen || touchSeen) && !penSeen;

const DRAWS: Record<PointerKind, (state: Pick<InputState, 'penSeen' | 'fingerDraws'>) => boolean> = {
    mouse: () => true,
    pen: () => true,
    touch: ({ penSeen, fingerDraws }) => !penSeen && fingerDraws,
};

/** PointerEvent.pointerType is an open string; anything unrecognised draws like a mouse. */
export const pointerDraws = (
    pointer: string,
    toolInHand: boolean,
    state: Pick<InputState, 'penSeen' | 'fingerDraws'>,
): boolean => toolInHand && (DRAWS[pointer as PointerKind] ?? DRAWS.mouse)(state);
