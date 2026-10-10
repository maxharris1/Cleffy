import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `text-ok` is small text on a white card — the pricing dialog's "Two months
 * free" under the annual price. axe flagged it at 3.65:1 (emerald-600), under
 * the 4.5:1 WCAG AA asks of text that size. This resolves the token the way
 * the build does (src/index.css alias → Tailwind's own oklch value) and checks
 * the ratio, so a later palette tweak cannot quietly bring it back.
 *
 * Resolved from the project root: jsdom gives import.meta a non-file URL.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const INDEX_CSS = read('src/index.css');
const TAILWIND_THEME = read('node_modules/tailwindcss/theme.css');

/** `--color-<name>` from our theme, followed through one `var()` into Tailwind's palette. */
const resolveColor = (name: string): string => {
    const own = INDEX_CSS.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1]?.trim();
    expect(own, `--color-${name} is not defined in src/index.css`).toBeDefined();
    const alias = own?.match(/^var\(--color-([\w-]+)\)$/)?.[1];
    if (!alias) {
        return own ?? '';
    }
    const stock = TAILWIND_THEME.match(new RegExp(`--color-${alias}:\\s*([^;]+);`))?.[1]?.trim();
    expect(stock, `--color-${alias} is not in Tailwind's theme`).toBeDefined();
    return stock ?? '';
};

/** oklch(L% C H) → linear-light sRGB channels (CSS Color 4 / Björn Ottosson's matrices). */
const oklchToLinearSrgb = (value: string): [number, number, number] => {
    const parts = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
    expect(parts, `not an oklch() colour: ${value}`).not.toBeNull();
    const [l, c, h] = [Number(parts?.[1]) / 100, Number(parts?.[2]), (Number(parts?.[3]) * Math.PI) / 180];
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
        clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
        clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
        clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    ];
};

const relativeLuminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const contrastOnWhite = (value: string) => 1.05 / (relativeLuminance(oklchToLinearSrgb(value)) + 0.05);

describe('status text colours', () => {
    it('reproduces the failure axe reported, so the arithmetic below can be trusted', () => {
        expect(contrastOnWhite('oklch(59.6% 0.145 163.225)')).toBeCloseTo(3.65, 1);
    });

    it('text-ok reads at WCAG AA (4.5:1) on white', () => {
        expect(contrastOnWhite(resolveColor('ok'))).toBeGreaterThanOrEqual(4.5);
    });

    it('the pricing note still uses the token', () => {
        expect(read('src/features/billing/PricingDialog.tsx')).toMatch(/text-xs text-ok/);
    });
});
