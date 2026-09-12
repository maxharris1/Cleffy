import { describe, expect, it } from 'vitest';

import type { ScoreData } from '../scoreData.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from '../scoreData.js';
import { compareScore } from './compare.js';
import type { CorpusEntry, CorpusMovement } from './manifest.js';
import type { RefNote } from './midiRef.js';
import { allowedMisses, defaultLimits, formatGate, playAlongGate, type CheckId } from './playAlong.js';
import { segmentMovements } from './segment.js';

const movement = (over: Partial<CorpusMovement> = {}): CorpusMovement => ({
    name: 'I',
    midi: 'i.mid',
    meter: { num: 4, den: 4 },
    pickupQuarters: 0,
    printedBars: 2,
    expectedFifths: 0,
    expectedTempo: { min: 90, max: 110 },
    repeatsUnfoldedInMidi: false,
    performedBars: 2,
    expectedHolds: 0,
    expectedExtraNotes: 0,
    ...over,
});

const entryOf = (over: Partial<CorpusMovement> = {}): CorpusEntry => ({
    slug: 'toy',
    title: 'Toy',
    pdf: { url: 'https://example.test/t.pdf', pages: 1 },
    reference: { source: 'mutopia', url: 'https://example.test/t.mid', sha256: '0'.repeat(64), license: 'CC' },
    movements: [movement(over)],
    editionNotes: [],
});

/** Two 4/4 bars of four quarters, the printed grid a correct reading reproduces. */
const refNotes = (): RefNote[] => {
    const out: RefNote[] = [];
    for (const bar of [1, 2]) {
        for (let beat = 0; beat < 4; beat++) {
            out.push({ bar, onsetQ: beat, durQ: 1, pitch: 60 + beat, hand: 0 });
        }
    }
    return out;
};

interface ScoreOver {
    notes?: ScoreData['notes'];
    dTicks?: number[];
    holds?: ScoreData['holds'];
    warnings?: string[];
    pickupQuarters?: number;
}

const GATE_DEFAULT_TICKS = 432; // a quarter at the parser's plain articulation gate (480 × 0.9)

const scoreOf = (over: ScoreOver = {}): ScoreData => {
    const dTicks = over.dTicks ?? [1920, 1920];
    let tick = 0;
    const measures = dTicks.map((d, i) => {
        const m = { n: i + 1, tick, dTicks: d, page: 0, sys: 0, x0: 0, x1: 1, srcIndex: i };
        tick += d;
        return m;
    });
    const notes =
        over.notes ??
        dTicks.flatMap((_, bar) =>
            [0, 1, 2, 3].map((beat) => ({
                t: measures[bar]!.tick + beat * TICKS_PER_QUARTER,
                d: GATE_DEFAULT_TICKS,
                p: 60 + beat,
                h: 0 as const,
            })),
        );
    return {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: 100,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        keySignatures: [{ tick: 0, fifths: 0 }],
        tempos: [{ tick: 0, bpm: 100, src: 'metronome' }],
        ...(over.holds ? { holds: over.holds } : {}),
        totalTicks: Math.max(tick, 1),
        notes,
        measures,
        systems: [],
        warnings: over.warnings ?? [],
    };
};

const gate = (score: ScoreData, entry = entryOf(), refs = refNotes()) =>
    playAlongGate(compareScore(score, entry, [refs], segmentMovements(score, entry)));

const checkOf = (score: ScoreData, id: CheckId, entry = entryOf(), refs = refNotes()) => {
    const verdict = gate(score, entry, refs);
    return [...verdict.pieceChecks, ...verdict.movements.flatMap((m) => m.checks)].find((c) => c.id === id);
};

describe('playAlongGate', () => {
    it('passes a clean reading and reports 100% on-grid', () => {
        const verdict = gate(scoreOf());
        expect(verdict.failures).toEqual([]);
        expect(verdict.pass).toBe(true);
        expect(verdict.score).toBe(100);
    });

    it('narrows: onGrid <= exact <= pitchMatch', () => {
        const verdict = gate(scoreOf());
        const mov = verdict.movements[0]!;
        expect(mov.onGrid).toBeLessThanOrEqual(mov.exact);
        expect(mov.exact).toBeLessThanOrEqual(mov.pitchMatch);
    });

    it('reads a gated sounding duration as the printed length', () => {
        // The parser emits notated × articulation gate, never the notated value.
        // Every legal gate has to count as the printed length or a correct
        // reading scores zero on duration.
        for (const gateFactor of [1, 0.9, 0.7, 0.5, 0.25]) {
            const notes = scoreOf().notes.map((n) => ({ ...n, d: Math.round(480 * gateFactor) }));
            expect(gate(scoreOf({ notes })).movements[0]?.onGrid, `gate ${gateFactor}`).toBe(100);
        }
    });

    it('fails a note held through the next attack', () => {
        // No articulation gate exceeds 1, so an over-held note has no escape.
        const notes = scoreOf().notes.map((n, i) => (i === 0 ? { ...n, d: 960 } : n));
        const verdict = gate(scoreOf({ notes }));
        expect(verdict.movements[0]?.onGrid).toBeLessThan(100);
        expect(verdict.failures.join(' ')).toContain('note-length');
    });

    it('fails right notes on wrong beats while pitch stays perfect', () => {
        const notes = scoreOf().notes.map((n, i) => (i < 4 ? { ...n, t: n.t + 60 } : n));
        const verdict = gate(scoreOf({ notes }));
        expect(verdict.movements[0]?.pitchMatch).toBe(100);
        expect(verdict.failures.join(' ')).toContain('attack-grid');
    });

    it('fails a wrong-length bar', () => {
        expect(checkOf(scoreOf({ dTicks: [2400, 1920] }), 'bar-length')?.ok).toBe(false);
    });

    it('treats a pickup as legitimately short, not as a wrong-length bar', () => {
        // The parser leaves pickups at content length; measuring one against a
        // full bar would red-X every anacrusis in the corpus.
        const entry = entryOf({ pickupQuarters: 1, printedBars: 2, performedBars: 2 });
        const refs: RefNote[] = [
            { bar: 0, onsetQ: 3, durQ: 1, pitch: 60, hand: 0 },
            ...[0, 1, 2, 3].map((beat) => ({ bar: 1, onsetQ: beat, durQ: 1, pitch: 60 + beat, hand: 0 as const })),
        ];
        const score = scoreOf({
            dTicks: [480, 1920],
            notes: [
                { t: 0, d: GATE_DEFAULT_TICKS, p: 60, h: 0 },
                ...[0, 1, 2, 3].map((beat) => ({
                    t: 480 + beat * TICKS_PER_QUARTER,
                    d: GATE_DEFAULT_TICKS,
                    p: 60 + beat,
                    h: 0 as const,
                })),
            ],
        });
        const verdict = gate(score, entry, refs);
        expect(verdict.movements[0]?.checks.find((c) => c.id === 'bar-length')?.ok).toBe(true);
        // And the pickup note itself pairs: midiRef right-aligns it in a notional
        // full bar, so the OMR side has to be shifted the same way.
        expect(verdict.movements[0]?.exact).toBe(100);
    });

    it('fails an invented hold but forgives a fermata it missed', () => {
        expect(checkOf(scoreOf({ holds: [{ tick: 960, beats: 2 }] }), 'no-invented-hold')?.ok).toBe(false);
        const withPin = entryOf({ expectedHolds: 2 });
        expect(checkOf(scoreOf(), 'no-invented-hold', withPin)?.ok).toBe(true);
    });

    it('fails the padded-underfull hole that bar length cannot see', () => {
        // The parser pads a short non-pickup bar up to the meter, so dTicks looks
        // right afterwards and only the warning still knows.
        const verdict = gate(scoreOf({ warnings: ['measure_underfull'] }));
        expect(verdict.pieceChecks.find((c) => c.id === 'bar-length-warning')?.ok).toBe(false);
        expect(verdict.pass).toBe(false);
    });

    it('fails repeats_ignored', () => {
        expect(checkOf(scoreOf({ warnings: ['repeats_ignored'] }), 'repeat-structure')?.ok).toBe(false);
        expect(checkOf(scoreOf({ warnings: ['repeats_unrolled'] }), 'repeat-structure')?.ok).toBe(true);
    });

    it('skips the repeat walk when performedBars is not pinned', () => {
        const entry: CorpusEntry = { ...entryOf(), movements: [movement({ performedBars: undefined })] };
        const check = checkOf(scoreOf(), 'repeat-walk', entry);
        expect(check?.ok).toBe(null);
        expect(gate(scoreOf(), entry).pass).toBe(true);
    });

    it('forgives ornament notes the reference MIDI does not realize', () => {
        // One extra note per bar: 2 extras, above the 1-note allowance for 2 bars.
        const notes = [
            ...scoreOf().notes,
            { t: 240, d: 60, p: 62, h: 0 as const },
            { t: 2160, d: 60, p: 62, h: 0 as const },
        ];
        expect(checkOf(scoreOf({ notes }), 'no-invented-notes')?.ok).toBe(false);
        const pinned = entryOf({ expectedExtraNotes: 2 });
        expect(checkOf(scoreOf({ notes }), 'no-invented-notes', pinned)?.ok).toBe(true);
    });

    it('catches a skipped passage that a per-note rate would dilute', () => {
        const longEntry = entryOf({ printedBars: 6, performedBars: 6 });
        const refs: RefNote[] = [];
        for (const bar of [1, 2, 3, 4, 5, 6]) {
            for (let beat = 0; beat < 4; beat++) {
                refs.push({ bar, onsetQ: beat, durQ: 1, pitch: 60 + beat, hand: 0 });
            }
        }
        // Bars 3 and 4 are simply not on the page the OMR read.
        const score = scoreOf({
            dTicks: [1920, 1920, 1920, 1920],
            notes: [0, 1, 2, 3].flatMap((i) =>
                [0, 1, 2, 3].map((beat) => ({
                    t: i * 1920 + beat * TICKS_PER_QUARTER,
                    d: GATE_DEFAULT_TICKS,
                    p: 60 + beat,
                    h: 0 as const,
                })),
            ),
        });
        const verdict = gate(score, longEntry, refs);
        expect(verdict.movements[0]?.checks.find((c) => c.id === 'no-skipped-passage')?.ok).toBe(false);
    });

    it('compares an unfolded reference against the performed measure list', () => {
        // One printed bar swept twice by a repeat, and a reference that unfolds
        // it: the deduped printed list would be half as long as the reference.
        const entry = entryOf({ repeatsUnfoldedInMidi: true, printedBars: 1, performedBars: 2 });
        const refs: RefNote[] = [1, 2].flatMap((bar) =>
            [0, 1, 2, 3].map((beat) => ({ bar, onsetQ: beat, durQ: 1, pitch: 60 + beat, hand: 0 as const })),
        );
        const score = scoreOf();
        score.measures[1]!.srcIndex = 0;
        const verdict = gate(score, entry, refs);
        expect(verdict.movements[0]?.onGrid).toBe(100);
        expect(verdict.movements[0]?.checks.find((c) => c.id === 'bar-alignment')?.ok).toBe(true);
    });

    it('reports printed tempo without gating on it', () => {
        const noTempo = scoreOf();
        noTempo.tempos = [];
        const verdict = gate(noTempo);
        // defaultBpm is a meter guess, so the printed opening is null, not 100.
        expect(verdict.movements[0]).toBeDefined();
        expect(verdict.pass).toBe(true);
    });

    it('allows one miss per 16 printed bars', () => {
        const limits = defaultLimits();
        expect(allowedMisses(1, limits)).toBe(1);
        expect(allowedMisses(16, limits)).toBe(1);
        expect(allowedMisses(17, limits)).toBe(2);
        expect(allowedMisses(105, limits)).toBe(7);
    });

    it('formats a failure list a human can read', () => {
        const text = formatGate(gate(scoreOf({ dTicks: [2400, 1920] })));
        expect(text).toContain('FAIL');
        expect(text).toContain('bar-length');
    });
});
