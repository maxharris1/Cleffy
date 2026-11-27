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

/** #rrggbb → linear-light sRGB channels. */
const hexToLinearSrgb = (hex: string): [number, number, number] => {
    const channel = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return [channel(0), channel(1), channel(2)];
};

/** WCAG contrast of an oklch() foreground on a #rrggbb background. */
const contrastOn = (value: string, background: string) => {
    const fg = relativeLuminance(oklchToLinearSrgb(value));
    const bg = relativeLuminance(hexToLinearSrgb(background));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
};

/** The `--color-<name>` hex our theme defines itself (paper, paper-deep). */
const ownHex = (name: string): string => {
    const own = INDEX_CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    expect(own, `--color-${name} is not a hex colour in src/index.css`).toBeDefined();
    return own ?? '';
};

describe('status text colours', () => {
    it('reproduces the failure axe reported, so the arithmetic below can be trusted', () => {
        expect(contrastOnWhite('oklch(59.6% 0.145 163.225)')).toBeCloseTo(3.65, 1);
    });

    it('text-ok reads at WCAG AA (4.5:1) on white', () => {
        expect(contrastOnWhite(resolveColor('ok'))).toBeGreaterThanOrEqual(4.5);
    });

    it('the pricing note still uses the token', () => {
        expect(read('src/features/billing/PlanCard.tsx')).toMatch(/note: 'text-ok'/);
    });
});

describe('danger text colour', () => {
    /**
     * `text-danger` is every inline error (ui/ErrorText) and every destructive
     * text button, on every light surface the app has. The viewer's "Could not
     * open this PDF" sat at 3.79:1 (#e7000b, red-600, on #e7e5e4), under AA.
     */
    const surfaces = {
        white: '#ffffff',
        paper: ownHex('paper'),
        'paper-deep': ownHex('paper-deep'),
        // Measured behind the viewer's error state (QA, axe), and stone-200.
        'viewer error backdrop': '#e7e5e4',
        // The hover wash of the destructive text buttons.
        'red-50': '#fef2f2',
    };

    it('reproduces the failure QA reported, so the arithmetic below can be trusted', () => {
        expect(contrastOn('oklch(57.7% 0.245 27.325)', '#e7e5e4')).toBeCloseTo(3.79, 1);
    });

    it.each(Object.entries(surfaces))('text-danger reads at WCAG AA (4.5:1) on %s', (_name, background) => {
        expect(contrastOn(resolveColor('danger'), background)).toBeGreaterThanOrEqual(4.5);
    });

    it('white text on a danger button reads at AA, hovered or not', () => {
        expect(contrastOnWhite(resolveColor('danger'))).toBeGreaterThanOrEqual(4.5);
        const hover = read('src/ui/classNames.ts').match(
            /\bdanger: '[^']*\bbg-danger text-white\b[^']*\bhover:bg-(red-\d+)'/,
        )?.[1];
        expect(hover).toBeDefined();
        const stock = TAILWIND_THEME.match(new RegExp(`--color-${hover}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
        expect(contrastOnWhite(stock)).toBeGreaterThanOrEqual(4.5);
    });
});

const hexContrast = (fg: string, bg: string) => {
    const [a, b] = [relativeLuminance(hexToLinearSrgb(fg)), relativeLuminance(hexToLinearSrgb(bg))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** A `--color-<name>` as linear sRGB: our own hex, or Tailwind's stock oklch. */
const hexOrStock = (name: string): [number, number, number] => {
    const own = INDEX_CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    if (own) {
        return hexToLinearSrgb(own);
    }
    const stock = TAILWIND_THEME.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1]?.trim();
    expect(stock, `--color-${name} is neither ours nor Tailwind's`).toBeDefined();
    return oklchToLinearSrgb(stock ?? '');
};

describe('dialog text on the paper panel', () => {
    const paper = ownHex('paper');
    const dialogStone500 = INDEX_CSS.match(/\.dialog-paper\s*\{[^}]*--color-stone-500:\s*(#[0-9a-f]{6});/)?.[1] ?? '';

    it('reproduces the failure review reported, so the arithmetic below can be trusted', () => {
        expect(contrastOn(TAILWIND_THEME.match(/--color-stone-500:\s*([^;]+);/)?.[1] ?? '', paper)).toBeCloseTo(
            4.41,
            1,
        );
    });

    it('every dialog panel carries the paper text palette', () => {
        expect(read('src/ui/DialogPanel.tsx')).toMatch(/\bdialog-paper\b/);
    });

    it('text-stone-500 inside a dialog reads at AA on paper', () => {
        expect(dialogStone500).toMatch(/^#/);
        expect(hexContrast(dialogStone500, paper)).toBeGreaterThanOrEqual(4.5);
    });

    /** Each Badge tone's text on its own tint, laid over the surfaces a badge sits on. */
    const BADGE = read('src/ui/Badge.tsx');
    const toneOf = (tone: string) => {
        const [, bg, alpha, text] = BADGE.match(new RegExp(`${tone}: 'bg-([\\w-]+)(?:/(\\d+))? text-([\\w-]+)'`)) ?? [];
        expect(text, `Badge tone ${tone}`).toBeDefined();
        return { bg: hexOrStock(bg ?? ''), alpha: alpha ? Number(alpha) / 100 : 1, text: hexOrStock(text ?? '') };
    };

    it.each(['ok', 'warn', 'neutral'].flatMap((tone) => [[tone, 'paper'] as const, [tone, 'white'] as const]))(
        'the %s badge reads at AA on %s',
        (tone, surface) => {
            const { bg, alpha, text } = toneOf(tone);
            const under = hexToLinearSrgb(surface === 'paper' ? paper : '#ffffff');
            const [r, g, b] = bg.map((v, i) =>
                srgbToLinear(linearToSrgb(v) * alpha + linearToSrgb(under[i] ?? 0) * (1 - alpha)),
            );
            const fg = relativeLuminance(text);
            const back = relativeLuminance([r ?? 0, g ?? 0, b ?? 0]);
            expect((Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05)).toBeGreaterThanOrEqual(4.5);
        },
    );
});

describe('hovered dialog row', () => {
    const alpha = Number(read('src/features/library/TagManageDialog.tsx').match(/hover:bg-ink\/(\d+)/)?.[1]) / 100;
    const ink = hexOrStock('ink');
    const washOver = (surface: string): [number, number, number] => {
        const under = hexToLinearSrgb(surface);
        const [r, g, b] = ink.map((v, i) =>
            srgbToLinear(linearToSrgb(v) * alpha + linearToSrgb(under[i] ?? 0) * (1 - alpha)),
        );
        return [r ?? 0, g ?? 0, b ?? 0];
    };
    const contrast = (fg: [number, number, number], bg: [number, number, number]) => {
        const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)];
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const dialogStone500 = INDEX_CSS.match(/\.dialog-paper\s*\{[^}]*--color-stone-500:\s*(#[0-9a-f]{6});/)?.[1] ?? '';
    const surfaces = { paper: ownHex('paper'), white: '#ffffff' };

    it('reproduces the failure review reported, so the arithmetic below can be trusted', () => {
        expect(alpha).toBeGreaterThan(0);
        expect(contrast(hexToLinearSrgb('#736b65'), washOver(surfaces.paper))).toBeCloseTo(4.3, 1);
    });

    it.each(Object.entries(surfaces))(
        'text-stone-500 inside a dialog reads at AA on a hovered row over %s',
        (_n, s) => {
            expect(contrast(hexToLinearSrgb(dialogStone500), washOver(s))).toBeGreaterThanOrEqual(4.5);
        },
    );

    it.each(Object.entries(surfaces))('text-danger reads at AA on a hovered row over %s', (_n, s) => {
        expect(contrast(oklchToLinearSrgb(resolveColor('danger')), washOver(s))).toBeGreaterThanOrEqual(4.5);
    });
});
