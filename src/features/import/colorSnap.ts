import { STROKE_COLORS } from '@/state/store';

/**
 * Snap detected ink colors onto the app palette (Oklab nearest-neighbor) so
 * imported marks match what the user could have drawn — teacher blue becomes
 * palette blue, red stays red. Colors farther than SNAP_MAX_DE from every
 * swatch keep their measured hex (the DB accepts any hex).
 */
export const SNAP_MAX_DE = 0.18;

export interface Oklab {
    L: number;
    a: number;
    b: number;
}

const srgbToLinear = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

export const hexToRgb = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        return [0, 0, 0];
    }
    const v = parseInt(m[1] ?? '0', 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
};

/** sRGB → Oklab (Björn Ottosson's reference constants). */
export const rgbToOklab = (r8: number, g8: number, b8: number): Oklab => {
    const r = srgbToLinear(r8);
    const g = srgbToLinear(g8);
    const b = srgbToLinear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
        L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    };
};

export const oklabDeltaE = (x: Oklab, y: Oklab): number =>
    Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);

const PALETTE: { hex: string; lab: Oklab }[] = STROKE_COLORS.map((hex) => ({
    hex,
    lab: rgbToOklab(...hexToRgb(hex)),
}));

/** Nearest palette color for a measured ink hex, or the hex itself when nothing is close. */
export const snapToPalette = (hex: string): string => {
    const lab = rgbToOklab(...hexToRgb(hex));
    let best: string = hex;
    let bestDe = Number.POSITIVE_INFINITY;
    for (const swatch of PALETTE) {
        const de = oklabDeltaE(lab, swatch.lab);
        if (de < bestDe) {
            bestDe = de;
            best = swatch.hex;
        }
    }
    return bestDe <= SNAP_MAX_DE ? best : hex;
};
