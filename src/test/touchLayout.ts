import { expect, vi } from 'vitest';

export interface Viewport {
    width: number;
    coarse: boolean;
}

export interface EffectiveBox {
    paddingTop: number;
    paddingBottom: number;
    height: number;
    minWidth: number;
    hit44: boolean;
    hit44y: boolean;
    /** How far a ::before target reaches past the top and bottom edges. */
    overhangY: number;
}

const REM_PX = 16;
const SPACING_PX = 4;

const lengthPx = (value: string): number =>
    value.endsWith('rem') ? Number.parseFloat(value) * REM_PX : Number.parseFloat(value);

const FEATURES: Record<string, (value: string, viewport: Viewport) => boolean> = {
    'min-width': (value, { width }) => width >= lengthPx(value),
    'max-width': (value, { width }) => width <= lengthPx(value),
    pointer: (value, { coarse }) => value === (coarse ? 'coarse' : 'fine'),
    'any-pointer': (value, { coarse }) => value === (coarse ? 'coarse' : 'fine'),
};

const matchesQuery = (query: string, viewport: Viewport): boolean => {
    const negated = query.trim().startsWith('not all and ');
    const features = query
        .replace(/^\s*not all and /, '')
        .split(/\s+and\s+/)
        .map((part) => /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part.trim()));
    const all = features.every((m) => m !== null && (FEATURES[m[1] as string]?.(m[2] as string, viewport) ?? false));
    return negated ? !all : all;
};

/** Puts the window at this width and pointer; window.matchMedia answers from it. */
export const useViewport = (viewport: Viewport): void => {
    vi.stubGlobal('innerWidth', viewport.width);
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: matchesQuery(query, viewport),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    }));
};

const VARIANTS: Record<string, (el: HTMLElement) => boolean> = {
    sm: () => window.matchMedia('(min-width: 40rem)').matches,
    'max-sm': () => !window.matchMedia('(min-width: 40rem)').matches,
    'pointer-coarse': () => window.matchMedia('(pointer: coarse)').matches,
    'pointer-fine': () => window.matchMedia('(pointer: fine)').matches,
    'touch-ui': (el) =>
        window.matchMedia('(pointer: coarse)').matches || el.parentElement?.closest('[data-touch-ui]') != null,
};

const spacingPx = (value: string): number => {
    const arbitrary = /^\[(.+)\]$/.exec(value);
    return arbitrary ? lengthPx(arbitrary[1] as string) : Number(value) * SPACING_PX;
};

/* Listed in Tailwind's own order (p before py before pt/pb), so a later rule wins at equal variant depth. */
const UTILITIES: readonly [RegExp, (value: string) => Partial<EffectiveBox>][] = [
    [/^p-(.+)$/, (v) => ({ paddingTop: spacingPx(v), paddingBottom: spacingPx(v) })],
    [/^py-(.+)$/, (v) => ({ paddingTop: spacingPx(v), paddingBottom: spacingPx(v) })],
    [/^pt-(.+)$/, (v) => ({ paddingTop: spacingPx(v) })],
    [/^pb-(.+)$/, (v) => ({ paddingBottom: spacingPx(v) })],
    [/^h-(.+)$/, (v) => ({ height: spacingPx(v) })],
    [/^min-w-(.+)$/, (v) => ({ minWidth: spacingPx(v) })],
    [/^(hit-44)$/, () => ({ hit44: true })],
    [/^(hit-44-y)$/, () => ({ hit44y: true })],
    [/^before:-inset-y-(.+)$/, (v) => ({ overhangY: spacingPx(v) })],
];

const inlinePx = (value: string): number | undefined => (value === '' ? undefined : lengthPx(value));

/**
 * The box Tailwind gives `el` under the current window.matchMedia, then its
 * inline style on top. Classes with a variant other than the breakpoint and
 * pointer ones (hover:, focus:, data-*) never apply at rest, so they are skipped.
 */
export const effectiveBox = (el: HTMLElement): EffectiveBox => {
    const applied = Array.from(el.classList)
        .map((cls) => {
            const parts = cls.split(':');
            const utility = parts.at(-2) === 'before' ? parts.splice(-2).join(':') : (parts.pop() as string);
            const ruleIndex = UTILITIES.findIndex(([pattern]) => pattern.test(utility));
            const active = parts.every((variant) => VARIANTS[variant]?.(el) ?? false);
            return { utility, depth: parts.length, ruleIndex, active };
        })
        .filter(({ ruleIndex, active }) => ruleIndex >= 0 && active)
        .sort((a, b) => a.depth - b.depth || a.ruleIndex - b.ruleIndex);

    const box: EffectiveBox = {
        paddingTop: 0,
        paddingBottom: 0,
        height: 0,
        minWidth: 0,
        hit44: false,
        hit44y: false,
        overhangY: 0,
    };
    for (const { utility, ruleIndex } of applied) {
        const [pattern, resolve] = UTILITIES[ruleIndex] as (typeof UTILITIES)[number];
        Object.assign(box, resolve((pattern.exec(utility) as RegExpExecArray)[1] as string));
    }

    const style = el.style as CSSStyleDeclaration & { paddingBlock?: string };
    const block = inlinePx(style.paddingBlock ?? '');
    const inline: Partial<EffectiveBox> = {
        paddingTop: inlinePx(style.paddingTop) ?? block,
        paddingBottom: inlinePx(style.paddingBottom) ?? block,
        height: inlinePx(style.height),
        minWidth: inlinePx(style.minWidth),
    };
    for (const [key, value] of Object.entries(inline)) {
        if (value !== undefined) Object.assign(box, { [key]: value });
    }
    return box;
};

const TOUCH_TARGET_PX = 44;
const CHIP_FACE_PX = 34;

/**
 * Every button in a scrolling chip row keeps a 34px face and owns a 44x44px
 * target: the row's padding holds the vertical overhang (overflow-x: auto
 * clips y), and a face at least 44px wide keeps the centred target inside it,
 * so gap-separated neighbours never overlap.
 */
export const expectOwnTouchTargets = (row: HTMLElement): void => {
    const rowBox = effectiveBox(row);
    const chips = Array.from(row.querySelectorAll('button'));
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
        const box = effectiveBox(chip);
        const label = chip.textContent;
        expect(box.height, label ?? '').toBe(CHIP_FACE_PX);
        expect(box.hit44, `${label} has a touch target`).toBe(true);
        const overhang = (Math.max(box.height, TOUCH_TARGET_PX) - box.height) / 2;
        expect(rowBox.paddingTop, `${label} target clipped above`).toBeGreaterThanOrEqual(overhang);
        expect(rowBox.paddingBottom, `${label} target clipped below`).toBeGreaterThanOrEqual(overhang);
        expect(box.minWidth, `${label} target overlaps a neighbour`).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    }
};
