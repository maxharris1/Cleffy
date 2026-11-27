import { describe, expect, it } from 'vitest';

import { pointerDraws, showFingerSwitch, type PointerKind } from '@/features/viewer/ink/inputPolicy';

describe('pointerDraws', () => {
    const rows: [PointerKind, boolean, boolean, boolean, boolean][] = [
        // pointer, toolInHand, fingerDraws, penSeen, draws
        ['mouse', false, false, false, false],
        ['mouse', false, false, true, false],
        ['mouse', false, true, false, false],
        ['mouse', false, true, true, false],
        ['mouse', true, false, false, true],
        ['mouse', true, false, true, true],
        ['mouse', true, true, false, true],
        ['mouse', true, true, true, true],
        ['touch', false, false, false, false],
        ['touch', false, false, true, false],
        ['touch', false, true, false, false],
        ['touch', false, true, true, false],
        ['touch', true, false, false, false],
        ['touch', true, false, true, false],
        ['touch', true, true, false, true],
        ['touch', true, true, true, false],
        ['pen', false, false, false, false],
        ['pen', false, false, true, false],
        ['pen', false, true, false, false],
        ['pen', false, true, true, false],
        ['pen', true, false, false, true],
        ['pen', true, false, true, true],
        ['pen', true, true, false, true],
        ['pen', true, true, true, true],
    ];

    it.each(rows)(
        '%s, tool in hand %s, fingerDraws %s, penSeen %s: draws %s',
        (pointer, toolInHand, fingerDraws, penSeen, draws) => {
            expect(pointerDraws(pointer, toolInHand, { fingerDraws, penSeen })).toBe(draws);
        },
    );

    it('treats an unknown pointer type like a mouse', () => {
        expect(pointerDraws('', true, { fingerDraws: false, penSeen: true })).toBe(true);
        expect(pointerDraws('', false, { fingerDraws: false, penSeen: true })).toBe(false);
    });
});

describe('showFingerSwitch', () => {
    it.each([
        [false, false, false, false],
        [false, false, true, false],
        [false, true, false, true],
        [false, true, true, false],
        [true, false, false, true],
        [true, false, true, false],
        [true, true, false, true],
        [true, true, true, false],
    ])('touch screen %s, touch seen %s, pen seen %s: shown %s', (touchScreen, touchSeen, penSeen, shown) => {
        expect(showFingerSwitch({ touchScreen, touchSeen, penSeen })).toBe(shown);
    });
});
