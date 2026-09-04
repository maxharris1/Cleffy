import { describe, expect, it } from 'vitest';

import { parseMusicXmlString } from '../../musicxml.js';
import { TICKS_PER_QUARTER } from '../../scoreData.js';
import type { LlmPageTranscription } from './schema.js';
import { parseVoice, toMusicXml } from './toMusicXml.js';

const Q = TICKS_PER_QUARTER;

describe('parseVoice', () => {
    it('reads pitches, chords, rests, dots, tuplets, graces and ties', () => {
        const v = parseVoice('C4:q [E4 G#4]:e. r:s gD5:s A5:e/3~ Bb3:x..');
        expect(v.errors).toEqual([]);
        expect(v.events.map((e) => e.ticks)).toEqual([Q, Q * 0.75, Q / 4, 0, Math.round((Q / 2) * (2 / 3)), Math.round((Q / 16) * 1.75)]);
        expect(v.events[1]!.pitches).toEqual([
            { step: 'E', alter: 0, octave: 4 },
            { step: 'G', alter: 1, octave: 4 },
        ]);
        expect(v.events[2]!.pitches).toBeNull();
        expect(v.events[3]!.grace).toBe(true);
        expect(v.events[4]!.tie).toBe(true);
        expect(v.events[4]!.tuplet).toEqual({ actual: 3, normal: 2 });
        expect(v.events[5]!.pitches).toEqual([{ step: 'B', alter: -1, octave: 3 }]);
    });

    it('tolerates a detached tie and a misplaced dot', () => {
        const v = parseVoice('A3.:e ~ A3:s');
        expect(v.errors).toEqual([]);
        expect(v.events.map((e) => [e.ticks, e.tie])).toEqual([
            [Q * 0.75, true],
            [Q / 4, false],
        ]);
    });

    it('drops malformed tokens and reports them', () => {
        const v = parseVoice('C4:q H4:q E4:z C4');
        expect(v.events).toHaveLength(1);
        expect(v.errors).toEqual(['H4:q', 'E4:z', 'C4']);
    });
});

const page = (measures: LlmPageTranscription['systems'][number]['measures']): LlmPageTranscription => ({ systems: [{ measures }] });

describe('toMusicXml', () => {
    it('round-trips through the production parser with hands, ties, repeats and a pickup', () => {
        const pages = [
            page([
                { n: 1, ts: '3/4', key: 1, tempo: 96, rep: null, ending: null, dyn: 'p', rh: ['D5:q'], lh: ['r:q'] },
                { n: 2, ts: null, key: null, tempo: null, rep: 'start', ending: null, dyn: null, rh: ['G4:q~ G4:q B4:q', 'r:q D4:h'], lh: ['[G2 D3]:h.'] },
                { n: 3, ts: null, key: null, tempo: null, rep: 'end', ending: 1, dyn: null, rh: ['A4:h.'], lh: ['r:h.'] },
                { n: 4, ts: null, key: null, tempo: null, rep: null, ending: 2, dyn: null, rh: ['G4:h.'], lh: ['G2:h.'] },
            ]),
        ];
        const { xml, stats } = toMusicXml(pages);
        const musical = parseMusicXmlString(xml);

        // Pickup bar is measure 0 and one quarter long; the rest are 3/4.
        expect(musical.measures.map((m) => m.n)).toEqual([0, 1, 2, 3]);
        expect(musical.measures.map((m) => m.dTicks)).toEqual([Q, 3 * Q, 3 * Q, 3 * Q]);
        expect(musical.timeSignatures[0]).toMatchObject({ num: 3, den: 4 });

        // Hands: staff 1 → h 0, staff 2 → h 1.
        const rh = musical.notes.filter((n) => n.h === 0);
        const lh = musical.notes.filter((n) => n.h === 1);
        expect(lh.map((n) => n.p).sort()).toEqual([43, 43, 50].sort());
        // The tied G4 pair merged into one half note (the parser gates plain
        // notes slightly short, so compare against the un-merged quarter).
        const g4 = rh.filter((n) => n.p === 67 && n.t === Q);
        expect(g4).toHaveLength(1);
        expect(g4[0]!.d).toBeGreaterThan(Q);
        expect(rh.filter((n) => n.p === 67 && n.t === 2 * Q)).toHaveLength(0);
        // Second voice on the upper staff kept its late entry.
        expect(rh.find((n) => n.p === 62)?.t).toBe(2 * Q);

        expect(musical.repeats[1]).toMatchObject({ repeatForward: true });
        expect(musical.repeats[2]).toMatchObject({ repeatBackward: true, endingStart: [1], endingStop: true });
        expect(musical.repeats[3]).toMatchObject({ endingStart: [2] });
        expect(musical.defaultBpm).toBe(96);
        expect(musical.keySignatures[0]).toMatchObject({ fifths: 1 });

        expect(stats.measures).toHaveLength(4);
        expect(stats.measures.every((m) => !m.overfull && !m.underfull)).toBe(true);
        expect(stats.pages[0]).toMatchObject({ measures: 4, bad: 0 });
    });

    it('flags overfull and underfull bars and parse errors per page', () => {
        const pages = [
            page([
                { n: 1, ts: '4/4', key: 0, tempo: null, rep: null, ending: null, dyn: null, rh: ['C4:w'], lh: ['C3:w'] },
                { n: 2, ts: null, key: null, tempo: null, rep: null, ending: null, dyn: null, rh: ['C4:w C4:q'], lh: ['C3:h'] },
                { n: 3, ts: null, key: null, tempo: null, rep: null, ending: null, dyn: null, rh: ['C4:q ??'], lh: ['r:w'] },
            ]),
        ];
        const { stats } = toMusicXml(pages);
        expect(stats.measures[1]).toMatchObject({ overfull: true, underfull: true });
        expect(stats.measures[2]).toMatchObject({ parseErrors: 1 });
        expect(stats.pages[0]).toMatchObject({ measures: 3, bad: 2, parseErrors: 1 });
    });

    it('treats a lone rest as a whole-bar rest whatever its written value', () => {
        const pages = [page([{ n: 1, ts: '6/8', key: 0, tempo: null, rep: null, ending: null, dyn: null, rh: ['r:w'], lh: ['C3:q. C3:q.'] }])];
        const { xml, stats } = toMusicXml(pages);
        expect(stats.measures[0]!.rh).toEqual([3 * Q]);
        const musical = parseMusicXmlString(xml);
        expect(musical.measures[0]!.dTicks).toBe(3 * Q);
    });
});
