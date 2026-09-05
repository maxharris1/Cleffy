import { describe, expect, it } from 'vitest';

import type { CheapGeometry, CheapStack } from './geometry/types.js';
import type { LlmMeasure, LlmPageTranscription } from './llm/schema.js';
import { measureOnsets, mergeGeometry } from './merge.js';

const bar = (rh: string[], lh: string[] = ['r:w']): LlmMeasure => ({
    n: 0,
    ts: null,
    key: null,
    tempo: null,
    rep: null,
    ending: null,
    dyn: null,
    rh,
    lh,
});

const stack = (x0: number, x1: number, columns: number[] = []): CheapStack => ({ x0, x1, slots: [], columns });

const geometry = (systems: CheapStack[][]): CheapGeometry => ({
    source: 'cv',
    timings: { renderMs: 0, detectMs: 0, totalMs: 0 },
    sheets: [
        {
            pageIndex: 0,
            widthPx: 1000,
            heightPx: 1400,
            systems: systems.map((stacks, i) => ({ y0: 0.1 + i * 0.3, y1: 0.3 + i * 0.3, staves: [], stacks })),
        },
    ],
});

const page = (systems: LlmMeasure[][]): LlmPageTranscription => ({
    systems: systems.map((measures) => ({ measures })),
});

describe('measureOnsets', () => {
    it('unions onsets across voices and staves, skipping graces', () => {
        const m = bar(['C4:q D4:q E4:h', 'gA4:s r:h F4:h'], ['C3:w']);
        expect(measureOnsets(m)).toEqual([0, 480, 960]);
    });
});

describe('mergeGeometry', () => {
    it('zips 1:1 when systems and bars agree, and derives slots from matching columns', () => {
        const geo = geometry([
            [stack(0.1, 0.5, [0.15, 0.25, 0.35, 0.45]), stack(0.5, 0.9, [0.6, 0.8])],
            [stack(0.1, 0.9, [0.2, 0.3])],
        ]);
        const llm = page([[bar(['C4:q D4:q E4:q F4:q']), bar(['G4:h A4:h'])], [bar(['C5:h', 'r:q E4:q. r:e'])]]);
        const { geometry: out, report } = mergeGeometry([llm], geo);
        expect(out?.sheets[0]!.systems.map((s) => s.stacks.length)).toEqual([2, 1]);
        expect(report.pages[0]!.mode).toBe('systems');
        expect(report.barsExact).toBe(3);
        expect(report.barsResplit).toBe(0);
        const first = out!.sheets[0]!.systems[0]!.stacks[0]!;
        expect(first.slots).toEqual([
            { x: 0.15, t: 0 },
            { x: 0.25, t: 480 },
            { x: 0.35, t: 960 },
            { x: 0.45, t: 1440 },
        ]);
        // Column count ≠ onset count → no slots rather than wrong slots.
        expect(out!.sheets[0]!.systems[1]!.stacks[0]!.slots).toEqual([]);
        expect(report.barsWithSlots).toBe(2);
    });

    it('drops leading clef/key columns in a system-opening bar', () => {
        const geo = geometry([[stack(0.1, 0.9, [0.12, 0.14, 0.3, 0.6])]]);
        const llm = page([[bar(['C4:h D4:h'])]]);
        const { geometry: out } = mergeGeometry([llm], geo);
        expect(out!.sheets[0]!.systems[0]!.stacks[0]!.slots).toEqual([
            { x: 0.3, t: 0 },
            { x: 0.6, t: 960 },
        ]);
    });

    it('re-splits a system evenly when the LLM counts a different number of bars', () => {
        const geo = geometry([[stack(0.1, 0.5), stack(0.5, 0.9)]]);
        const llm = page([[bar(['C4:w']), bar(['D4:w']), bar(['E4:w']), bar(['F4:w'])]]);
        const { geometry: out, report } = mergeGeometry([llm], geo);
        const xs = out!.sheets[0]!.systems[0]!.stacks.map((s) => [s.x0, s.x1].map((v) => Number(v.toFixed(2))));
        expect(xs).toEqual([
            [0.1, 0.3],
            [0.3, 0.5],
            [0.5, 0.7],
            [0.7, 0.9],
        ]);
        expect(report.pages[0]!.systems[0]!.mode).toBe('resplit');
        expect(report.barsResplit).toBe(4);
    });

    it('trusts the geometry line breaks when bar totals match but systems differ', () => {
        const geo = geometry([[stack(0.1, 0.5), stack(0.5, 0.9)], [stack(0.1, 0.9)]]);
        // LLM merged both lines into one system of three bars.
        const llm = page([[bar(['C4:w']), bar(['D4:w']), bar(['E4:w'])]]);
        const { geometry: out, report } = mergeGeometry([llm], geo);
        expect(report.pages[0]!.mode).toBe('flat');
        expect(out!.sheets[0]!.systems.map((s) => s.stacks.length)).toEqual([2, 1]);
        expect(report.barsExact).toBe(3);
    });

    it('distributes bars proportionally when neither systems nor totals match', () => {
        const geo = geometry([[stack(0.1, 0.5), stack(0.5, 0.9)], [stack(0.1, 0.9)]]);
        const llm = page([[bar(['C4:w']), bar(['D4:w'])], [bar(['E4:w']), bar(['F4:w'])], [bar(['G4:w'])]]);
        const { geometry: out, report } = mergeGeometry([llm], geo);
        expect(report.pages[0]!.mode).toBe('proportional');
        expect(out!.sheets[0]!.systems.map((s) => s.stacks.length)).toEqual([3, 2]);
        expect(out!.sheets[0]!.systems.flatMap((s) => s.stacks)).toHaveLength(5);
        expect(report.warnings).toContain('page_1_systems_proportional');
    });

    it('keeps every bar on its page with a whole-page system when the page has no geometry', () => {
        const geo: CheapGeometry = { source: 'cv', timings: { renderMs: 0, detectMs: 0, totalMs: 0 }, sheets: [] };
        const llm = page([[bar(['C4:w']), bar(['D4:w'])]]);
        const { geometry: out, report } = mergeGeometry([llm], geo);
        expect(out!.sheets[0]!.systems[0]!.stacks).toHaveLength(2);
        expect(report.warnings).toContain('page_1_no_geometry');
    });

    it('skips pages handed to the fallback engine', () => {
        const geo = geometry([[stack(0.1, 0.9)]]);
        const { geometry: out } = mergeGeometry([null], geo);
        expect(out!.sheets).toEqual([]);
    });
});
