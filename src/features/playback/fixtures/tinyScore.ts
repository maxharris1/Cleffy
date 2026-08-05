import type { ScoreData } from '@/types/scoreData';

/**
 * Hand-authored ScoreData for tests: 9 measures across 2 pages / 4 systems,
 * with a one-beat pickup (m. 0), a 4/4 → 6/8 change at m. 5, a chord, a
 * tie-merged note spanning a barline, and material in both hands.
 *
 * Tick map (480 tpq):
 *   m0 pickup  0–480      | m1 480–2400   m2 2400–4320   (page 0, system 0)
 *   m3 4320–6240          | m4 6240–8160                 (page 0, system 1)
 *   6/8 from 8160:
 *   m5 8160–9600          | m6 9600–11040                (page 1, system 2)
 *   m7 11040–12480        | m8 12480–13920               (page 1, system 3)
 */
export const tinyScore: ScoreData = {
    version: 1,
    ticksPerQuarter: 480,
    defaultBpm: 90,
    timeSignatures: [
        { tick: 0, num: 4, den: 4 },
        { tick: 8160, num: 6, den: 8 },
    ],
    totalTicks: 13920,
    notes: [
        { t: 0, d: 480, p: 72, h: 0 }, // pickup C5
        { t: 480, d: 960, p: 76, h: 0 }, // chord…
        { t: 480, d: 960, p: 79, h: 0 }, // …with G5
        { t: 480, d: 1920, p: 48, h: 1 },
        { t: 1440, d: 960, p: 77, h: 0 },
        { t: 2400, d: 3840, p: 81, h: 0 }, // tie-merged across the m2/m3 barline
        { t: 2400, d: 1920, p: 43, h: 1 },
        { t: 4320, d: 1920, p: 48, h: 1 },
        { t: 6240, d: 1920, p: 74, h: 0 },
        { t: 6240, d: 1920, p: 41, h: 1 },
        { t: 8160, d: 240, p: 84, h: 0, v: 0.9 },
        { t: 8160, d: 1440, p: 36, h: 1 },
        { t: 8400, d: 240, p: 83, h: 0 },
        { t: 8640, d: 240, p: 81, h: 0 },
        { t: 9600, d: 1440, p: 79, h: 0 },
        { t: 11040, d: 1440, p: 77, h: 0 },
        { t: 12480, d: 960, p: 76, h: 0 },
        { t: 13440, d: 480, p: 72, h: 0 },
        { t: 13440, d: 480, p: 36, h: 1 },
    ],
    measures: [
        { n: 0, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0.08, x1: 0.24 },
        { n: 1, tick: 480, dTicks: 1920, page: 0, sys: 0, x0: 0.24, x1: 0.58 },
        { n: 2, tick: 2400, dTicks: 1920, page: 0, sys: 0, x0: 0.58, x1: 0.92 },
        { n: 3, tick: 4320, dTicks: 1920, page: 0, sys: 1, x0: 0.08, x1: 0.5 },
        { n: 4, tick: 6240, dTicks: 1920, page: 0, sys: 1, x0: 0.5, x1: 0.92 },
        { n: 5, tick: 8160, dTicks: 1440, page: 1, sys: 2, x0: 0.08, x1: 0.5 },
        { n: 6, tick: 9600, dTicks: 1440, page: 1, sys: 2, x0: 0.5, x1: 0.92 },
        { n: 7, tick: 11040, dTicks: 1440, page: 1, sys: 3, x0: 0.08, x1: 0.5 },
        { n: 8, tick: 12480, dTicks: 1440, page: 1, sys: 3, x0: 0.5, x1: 0.92 },
    ],
    systems: [
        { page: 0, y0: 0.1, y1: 0.28 },
        { page: 0, y0: 0.4, y1: 0.58 },
        { page: 1, y0: 0.1, y1: 0.28 },
        { page: 1, y0: 0.4, y1: 0.58 },
    ],
    warnings: [],
};
