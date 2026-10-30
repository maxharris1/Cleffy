import { prefersReducedMotion } from '@/lib/motion';

/**
 * A short, decaying side-to-side shake: "no" from the field itself. On the
 * ease-out curve, 280ms, and on transform only.
 */
const KEYFRAMES: Keyframe[] = [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-6px)' },
    { transform: 'translateX(5px)' },
    { transform: 'translateX(-3px)' },
    { transform: 'translateX(2px)' },
    { transform: 'translateX(0)' },
];
const OPTIONS: KeyframeAnimationOptions = { duration: 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' };

/**
 * Shake `el` (Web Animations). Only for a server refusing what was typed — a
 * wrong code — never for a shape check while typing. A second refusal
 * restarts it from the top, which is the point: it is a second "no". Nothing
 * moves under reduced motion (the red border and the error text say it), and
 * nothing happens where the element cannot animate. Returns the animation, or
 * null when there was none.
 */
export const shake = (el: Element | null | undefined): Animation | null => {
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) {
        return null;
    }
    return el.animate(KEYFRAMES, OPTIONS);
};

/**
 * A refused code: shake its field's wrapper, then put the caret back in the
 * field with what was typed selected, so a child can type the code again
 * straight away rather than clear it first.
 */
export const refuseInput = (wrapper: Element | null | undefined, input: HTMLInputElement | null | undefined): void => {
    shake(wrapper);
    if (input) {
        input.focus();
        input.select();
    }
};
