import { describe, expect, it } from 'vitest';

import { buildScoreData } from '../buildScoreData.js';
import { compareScore } from '../eval/compare.js';
import { loadCorpusEntry } from '../eval/manifest.js';
import { notesFromMidi } from '../eval/midiRef.js';
import { segmentMovements } from '../eval/segment.js';
import { parseMusicXmlString } from '../musicxml.js';
import { TICKS_PER_QUARTER } from '../scoreData.js';
import {
    cachedMidiPath,
    matchCandidateForPin,
    midiForPin,
    SYMBOLIC_BENCH_SLUGS,
} from './evalRun.js';
import { ingestSymbolic, isUnusableScore } from './ingest.js';
import { unavailableLyConverter, type LyConverter } from './lyConvert.js';
import { decideSymbolic, type Decision } from './match.js';
import { scoreDataFromMidi } from './midiScore.js';
import { synthQuantizedMidi } from './midiSynth.js';
import { candidateFromMidi, pdfSignalsFromPin, type MatchCandidateInput } from './signals.js';
import { workKeyFromText } from './workKey.js';
import type { SymbolicFormat } from './types.js';

const wrap = (measures: string): string => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`;

const ATTRS_44 =
    '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';

const acceptDecision = (candidate: MatchCandidateInput): Decision => ({
    band: 'accept',
    reason: 'accept',
    best: {
        parts: { meter: 20, fifths: 15, barCount: 25, opening: 30, catalog: 10 },
        score: 100,
        band: 'accept',
        reason: 'accept',
        barError: 0,
        candidate,
        signals: {
            meter: true,
            fifths: true,
            barCountPdf: candidate.barCount,
            barCountCand: candidate.barCount,
            openingSim: 1,
            catalogHit: true,
        },
    },
    results: [],
});

const xmlCandidate = (format: SymbolicFormat): MatchCandidateInput =>
    candidateFromMidi(
        synthQuantizedMidi({
            meter: { num: 4, den: 4 },
            pickupQuarters: 0,
            printedBars: 1,
            fifths: 0,
            pitches: [60],
        }),
        {
            source: 'user',
            format,
            url: 'https://example.test/score.xml',
            workKey: { composerId: 'bach', catalogType: 'BWV', catalogN: 1 },
            meter: { num: 4, den: 4 },
            fifths: 0,
            pickupQuarters: 0,
            arrangement: false,
        },
    );

describe('scoreDataFromMidi', () => {
    it('builds measures for a 3/4 piece with pickup and a partial last bar', () => {
        const midi = synthQuantizedMidi({
            meter: { num: 3, den: 4 },
            pickupQuarters: 1,
            printedBars: 3,
            fifths: 0,
            pitches: [60, 62, 64],
            lastBarQuarters: 1,
        });
        const score = scoreDataFromMidi(midi, { meter: { num: 3, den: 4 }, pickupQuarters: 1, fifths: 0 });
        expect(score.measures).toHaveLength(3);
        expect(score.measures[0]).toMatchObject({ n: 0, tick: 0, dTicks: TICKS_PER_QUARTER, srcIndex: 0 });
        expect(score.measures[1]).toMatchObject({
            n: 1,
            tick: TICKS_PER_QUARTER,
            dTicks: TICKS_PER_QUARTER * 3,
            srcIndex: 1,
        });
        expect(score.measures[2]).toMatchObject({
            n: 2,
            tick: TICKS_PER_QUARTER * 4,
            dTicks: TICKS_PER_QUARTER,
            srcIndex: 2,
        });
        expect(score.measures[2]?.dTicks).toBeLessThan(TICKS_PER_QUARTER * 3);
        expect(score.notes.length).toBeGreaterThan(0);
        expect(score.timeSignatures[0]).toMatchObject({ num: 3, den: 4 });
    });
});

describe('ingestSymbolic', () => {
    it('reuses parseMusicXmlString / buildScoreData for MusicXML', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice></note></measure>`,
        );
        const expected = buildScoreData(parseMusicXmlString(xml), null, { autoPedal: false });
        const cand = xmlCandidate('xml');
        cand.format = 'xml';
        const logs: string[] = [];
        const result = ingestSymbolic(acceptDecision(cand), Buffer.from(xml), {
            log: (line) => logs.push(line),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.source.tier).toBe('symbolic');
        expect(result.source.format).toBe('xml');
        expect(result.score.notes).toEqual(expected.notes);
        expect(result.score.measures.map((m) => ({ n: m.n, tick: m.tick, dTicks: m.dTicks, srcIndex: m.srcIndex }))).toEqual(
            expected.measures.map((m) => ({ n: m.n, tick: m.tick, dTicks: m.dTicks, srcIndex: m.srcIndex })),
        );
        expect(logs).toEqual([]);
    });

    it('refuses non-accept decisions without parsing', () => {
        const decision: Decision = { band: 'reject', reason: 'low_score', best: null, results: [] };
        const logs: string[] = [];
        const result = ingestSymbolic(decision, Buffer.from('this is not musicxml'), { log: (line) => logs.push(line) });
        expect(result).toEqual({ ok: false, band: 'reject', reason: 'low_score', score: null });
        expect(logs).toEqual([]);
    });

    it('returns parser_unusable when MusicXML cannot be parsed', () => {
        const cand = xmlCandidate('xml');
        cand.format = 'xml';
        const logs: string[] = [];
        const result = ingestSymbolic(acceptDecision(cand), Buffer.from('<score-partwise version="4.0"></score-partwise>'), {
            log: (line) => logs.push(line),
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('parser_unusable');
        expect(result.band).toBe('reject');
        expect(logs.length).toBe(1);
        expect(logs[0]).toContain('"reason":"parser_unusable"');
    });

    it('returns parser_unusable for measure_overfull MusicXML', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<note><pitch><step>C</step><octave>4</octave></pitch><duration>32</duration><voice>1</voice></note></measure>`,
        );
        const cand = xmlCandidate('xml');
        cand.format = 'xml';
        const logs: string[] = [];
        const result = ingestSymbolic(acceptDecision(cand), Buffer.from(xml), { log: (line) => logs.push(line) });
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('parser_unusable');
        expect(logs[0]).toContain('parser_unusable');
    });

    it('returns parser_unusable for .ly when no converter is available', () => {
        const cand = xmlCandidate('ly');
        cand.format = 'ly';
        const result = ingestSymbolic(acceptDecision(cand), Buffer.from('\\version "2.24.0" { c\'4 }'), {
            lyConverter: unavailableLyConverter,
            log: () => undefined,
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('parser_unusable');
    });

    it('converts .ly through an injected LyConverter', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice></note></measure>`,
        );
        const converter: LyConverter = {
            name: 'test-ly',
            isAvailable: () => true,
            toMusicXml: () => Buffer.from(xml),
        };
        const cand = xmlCandidate('ly');
        cand.format = 'ly';
        const result = ingestSymbolic(acceptDecision(cand), Buffer.from('\\version "2.24.0" { c\'1 }'), {
            lyConverter: converter,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.score.notes.length).toBeGreaterThan(0);
        expect(result.source.format).toBe('ly');
    });
});

describe('isUnusableScore', () => {
    it('flags empty notes and measure_overfull', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice></note></measure>`,
        );
        const good = buildScoreData(parseMusicXmlString(xml), null, { autoPedal: false });
        expect(isUnusableScore(good)).toBe(false);
        expect(isUnusableScore({ ...good, notes: [], warnings: [] })).toBe(true);
        expect(isUnusableScore({ ...good, warnings: ['measure_overfull'] })).toBe(true);
    });
});

const roundTripOnGrid = (slug: (typeof SYMBOLIC_BENCH_SLUGS)[number], midi: Buffer): number => {
    const entry = loadCorpusEntry(slug);
    const workKey = workKeyFromText(entry.title);
    if (!workKey) {
        throw new Error(`${slug}: no WorkKey`);
    }
    const pdf = pdfSignalsFromPin(entry, midi, workKey);
    const cand = matchCandidateForPin(entry, midi, workKey);
    const decision = decideSymbolic(pdf, [cand]);
    expect(decision.band, slug).toBe('accept');
    const ingested = ingestSymbolic(decision, midi, { log: () => undefined });
    expect(ingested.ok, `${slug} ingest ${!ingested.ok ? ingested.reason : ''}`).toBe(true);
    if (!ingested.ok) {
        return 0;
    }
    const mov = entry.movements[0];
    if (!mov) {
        throw new Error(`${slug}: no movement`);
    }
    const result = compareScore(ingested.score, entry, [notesFromMidi(midi, mov)], segmentMovements(ingested.score, entry));
    return result.overall.onGrid;
};

describe('MIDI → ScoreData → MIDI round trip', () => {
    it('hits onGrid ≥ 99% on midiForPin (synthetic or cached) for the 16', () => {
        for (const slug of SYMBOLIC_BENCH_SLUGS) {
            const entry = loadCorpusEntry(slug);
            const midi = midiForPin(entry);
            expect(roundTripOnGrid(slug, midi), slug).toBeGreaterThanOrEqual(99);
        }
    });

    const cached = SYMBOLIC_BENCH_SLUGS.filter((slug) => cachedMidiPath(loadCorpusEntry(slug)) !== null);
    it.skipIf(cached.length === 0)(
        'hits onGrid ≥ 99% on cached Mutopia MIDI (skip: Mutopia MIDI not cached offline)',
        () => {
            for (const slug of cached) {
                const entry = loadCorpusEntry(slug);
                const path = cachedMidiPath(entry);
                if (path === null) {
                    continue;
                }
                const midi = midiForPin(entry);
                expect(roundTripOnGrid(slug, midi), slug).toBeGreaterThanOrEqual(99);
            }
        },
    );
});
