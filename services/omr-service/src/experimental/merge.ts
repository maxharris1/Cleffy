import type { OmrGeometry, OmrSheet, OmrSlot, OmrStack, OmrSystem } from '../omrGeometry.js';
import type { CheapGeometry, CheapStack, CheapSystem } from './geometry/types.js';
import type { LlmMeasure, LlmPageTranscription } from './llm/schema.js';
import { parseVoice } from './llm/toMusicXml.js';

/**
 * Merge Track B (what the bars contain) with Track A (where the bars are).
 *
 * Output is an OmrGeometry with exactly one stack per transcribed measure, in
 * reading order, so buildScoreData's positional zip is exact. Where the two
 * tracks disagree on bar counts the geometry is re-split rather than dropped:
 * a playhead on the right system at an approximate x beats no playhead.
 *
 * Bonus: when the CV pass found as many ink columns in a bar as the LLM found
 * onsets, they are zipped into `sl` slots — the fine playhead anchors the
 * production pipeline gets from Audiveris' rhythm step.
 */

export interface SystemMerge {
    llmBars: number;
    geoBars: number;
    /** exact: 1:1 stacks; resplit: geometry x-range divided evenly; none: no geometry. */
    mode: 'exact' | 'resplit';
    barsWithSlots: number;
}

export interface PageMerge {
    page: number;
    llmSystems: number;
    geoSystems: number;
    llmBars: number;
    geoBars: number;
    /** systems: per-system pairing; flat: bar totals matched but system split differed; proportional: distributed by stack share. */
    mode: 'systems' | 'flat' | 'proportional' | 'missing';
    systems: SystemMerge[];
}

export interface MergeReport {
    pages: PageMerge[];
    bars: number;
    barsExact: number;
    barsResplit: number;
    barsWithSlots: number;
    warnings: string[];
}

/** Distinct event onsets (ticks from bar start) across both staves' voices; graces excluded. */
export const measureOnsets = (m: LlmMeasure): number[] => {
    const onsets = new Set<number>();
    for (const voice of [...(m.rh ?? []), ...(m.lh ?? [])]) {
        let t = 0;
        for (const ev of parseVoice(voice).events) {
            if (ev.grace) {
                continue;
            }
            onsets.add(t);
            t += ev.ticks;
        }
    }
    return [...onsets].sort((a, b) => a - b);
};

const slotsFor = (m: LlmMeasure, stack: CheapStack, firstInSystem: boolean): OmrSlot[] => {
    const onsets = measureOnsets(m);
    if (onsets.length < 2) {
        return [];
    }
    let columns = stack.columns.filter((x) => x > stack.x0 && x < stack.x1);
    // The first bar of a system carries clef + key signature columns before the music.
    if (firstInSystem && columns.length > onsets.length) {
        columns = columns.slice(columns.length - onsets.length);
    }
    if (columns.length !== onsets.length) {
        return [];
    }
    return onsets.map((t, i) => ({ x: columns[i]!, t }));
};

const evenSplit = (x0: number, x1: number, n: number): OmrStack[] =>
    Array.from({ length: n }, (_, i) => ({ x0: x0 + ((x1 - x0) * i) / n, x1: x0 + ((x1 - x0) * (i + 1)) / n, slots: [] }));

const mergeSystem = (measures: LlmMeasure[], system: CheapSystem): { system: OmrSystem; merge: SystemMerge } => {
    const base = { y0: system.y0, y1: system.y1, staves: system.staves };
    if (measures.length === system.stacks.length) {
        let barsWithSlots = 0;
        const stacks = system.stacks.map((stack, i) => {
            const slots = slotsFor(measures[i]!, stack, i === 0);
            if (slots.length > 0) {
                barsWithSlots += 1;
            }
            return { x0: stack.x0, x1: stack.x1, slots };
        });
        return { system: { ...base, stacks }, merge: { llmBars: measures.length, geoBars: system.stacks.length, mode: 'exact', barsWithSlots } };
    }
    const x0 = system.stacks.length > 0 ? Math.min(...system.stacks.map((s) => s.x0)) : 0.05;
    const x1 = system.stacks.length > 0 ? Math.max(...system.stacks.map((s) => s.x1)) : 0.95;
    return {
        system: { ...base, stacks: evenSplit(x0, x1, measures.length) },
        merge: { llmBars: measures.length, geoBars: system.stacks.length, mode: 'resplit', barsWithSlots: 0 },
    };
};

/** Distribute n bars over systems proportionally to their stack counts (every system gets ≥1 while bars last). */
const distribute = (n: number, weights: number[]): number[] => {
    const total = weights.reduce((a, b) => a + b, 0) || weights.length;
    const raw = weights.map((w) => ((w || 1) / total) * n);
    const out = raw.map((r) => Math.floor(r));
    let remaining = n - out.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => ({ frac: r - Math.floor(r), i })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) {
        if (remaining <= 0) {
            break;
        }
        out[i]! += 1;
        remaining -= 1;
    }
    return out;
};

export const mergeGeometry = (
    pages: Array<LlmPageTranscription | null>,
    geometry: CheapGeometry | null,
): { geometry: OmrGeometry | null; report: MergeReport } => {
    const report: MergeReport = { pages: [], bars: 0, barsExact: 0, barsResplit: 0, barsWithSlots: 0, warnings: [] };
    if (!geometry) {
        report.warnings.push('no_geometry');
        return { geometry: null, report };
    }
    const sheets: OmrSheet[] = [];
    for (const [p, page] of pages.entries()) {
        if (!page) {
            continue;
        }
        const sheet = geometry.sheets.find((s) => s.pageIndex === p);
        const llmSystems = page.systems.filter((s) => s.measures.length > 0);
        const llmBars = llmSystems.reduce((n, s) => n + s.measures.length, 0);
        const pageMerge: PageMerge = {
            page: p,
            llmSystems: llmSystems.length,
            geoSystems: sheet?.systems.length ?? 0,
            llmBars,
            geoBars: sheet?.systems.reduce((n, s) => n + s.stacks.length, 0) ?? 0,
            mode: 'missing',
            systems: [],
        };
        report.bars += llmBars;
        if (!sheet || sheet.systems.length === 0) {
            // No geometry for this page: one whole-page system with evenly split bars
            // keeps the playhead on the right page at a plausible x.
            report.warnings.push(`page_${p + 1}_no_geometry`);
            report.barsResplit += llmBars;
            sheets.push({
                pageIndex: p,
                widthPx: sheet?.widthPx ?? 0,
                heightPx: sheet?.heightPx ?? 0,
                systems: llmSystems.map((s, i) => ({
                    y0: i / llmSystems.length,
                    y1: (i + 1) / llmSystems.length,
                    staves: [],
                    stacks: evenSplit(0.05, 0.95, s.measures.length),
                })),
            });
            report.pages.push(pageMerge);
            continue;
        }

        const systems: OmrSystem[] = [];
        const push = (measures: LlmMeasure[], geo: CheapSystem) => {
            const { system, merge } = mergeSystem(measures, geo);
            systems.push(system);
            pageMerge.systems.push(merge);
            if (merge.mode === 'exact') {
                report.barsExact += merge.llmBars;
            } else {
                report.barsResplit += merge.llmBars;
            }
            report.barsWithSlots += merge.barsWithSlots;
        };

        if (llmSystems.length === sheet.systems.length) {
            pageMerge.mode = 'systems';
            llmSystems.forEach((s, i) => push(s.measures, sheet.systems[i]!));
        } else if (llmBars === pageMerge.geoBars) {
            // Same bars, different line breaks: trust the geometry's systems.
            pageMerge.mode = 'flat';
            const flat = llmSystems.flatMap((s) => s.measures);
            let at = 0;
            for (const geo of sheet.systems) {
                push(flat.slice(at, at + geo.stacks.length), geo);
                at += geo.stacks.length;
            }
        } else {
            pageMerge.mode = 'proportional';
            const flat = llmSystems.flatMap((s) => s.measures);
            const counts = distribute(flat.length, sheet.systems.map((s) => s.stacks.length));
            let at = 0;
            sheet.systems.forEach((geo, i) => {
                push(flat.slice(at, at + counts[i]!), geo);
                at += counts[i]!;
            });
        }
        if (pageMerge.mode !== 'systems') {
            report.warnings.push(`page_${p + 1}_systems_${pageMerge.mode}`);
        }
        sheets.push({ pageIndex: p, widthPx: sheet.widthPx, heightPx: sheet.heightPx, systems });
        report.pages.push(pageMerge);
    }
    return { geometry: { sheets }, report };
};
