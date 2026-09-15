import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareScore } from '../eval/compare.js';
import { fetchCorpus } from '../eval/fetch.js';
import { loadCorpusEntry, type CorpusEntry } from '../eval/manifest.js';
import { notesFromMidi } from '../eval/midiRef.js';
import { artifactsCacheDir, downloadsDir } from '../eval/paths.js';
import { segmentMovements } from '../eval/segment.js';
import { ingestSymbolic } from './ingest.js';
import { decisionLogLine, formatDecisionLine, sha256Hex } from './log.js';
import { decideSymbolic, type MatchBand, type MatchReason } from './match.js';
import { synthQuantizedMidi } from './midiSynth.js';
import { mergePdfSignals, pdfSignalsFromArtifact, pdfSignalsFromPdf } from './pdfRead.js';
import { candidateFromMidi, type MatchCandidateInput, type PdfSignals } from './signals.js';
import { workKeyFromText } from './workKey.js';
import type { WorkKey } from './types.js';

/**
 * Same 16 slugs as `BENCH_SUITE`. Kept local so this module does not import
 * the bench runner (Audiveris / playAlong).
 */
export const SYMBOLIC_BENCH_SLUGS = [
    'czerny-op821-01',
    'bach-prelude-bwv939',
    'bach-air-anh131',
    'bach-invention-01',
    'bach-invention-08',
    'bach-prelude-bwv999',
    'wtk1-prelude1',
    'anna-magdalena-04',
    'anna-magdalena-05',
    'anna-magdalena-07',
    'burgmuller-op100-02',
    'schumann-op68-01',
    'schumann-op68-05',
    'gymnopedie-2',
    'fur-elise-mutopia',
    'chopin-prelude-4',
] as const;

export interface SymbolicEvalRow {
    id: string;
    set: 'bench' | 'false-match';
    band: MatchBand;
    reason: MatchReason;
    score: number;
    logLine: string;
    layoutBars?: number;
    pinPrintedBars?: number;
    layoutDelta?: number;
    openingSim?: number | null;
    /** compareScore vs the same MIDI as a library. Provenance, not a gate. */
    onGrid?: number;
    exact?: number;
    missing?: number;
    extra?: number;
}

export interface SymbolicEvalReport {
    rows: SymbolicEvalRow[];
    benchAccept: number;
    benchTotal: number;
    falseAccepts: number;
    falseTotal: number;
}

const pitchSeed = (slug: string): number[] => {
    let h = 0;
    for (let i = 0; i < slug.length; i++) {
        h = (h * 33 + slug.charCodeAt(i)) | 0;
    }
    const root = 48 + (Math.abs(h) % 24);
    return [root, root + 4, root + 7, root + 12];
};

const requireWorkKey = (entry: CorpusEntry): WorkKey => {
    const key = workKeyFromText(entry.title);
    if (!key) {
        throw new Error(`cannot parse WorkKey from ${entry.slug} title`);
    }
    return key;
};

/**
 * Prefer a cached Mutopia MIDI when present, including files whose MIDI
 * unfolds repeats. Match scoring compares pin `printedBars` (engraved), never
 * the performed length, so Op. 68 No. 1's 24-bar MIDI still fingerprints as
 * 20 printed bars. Otherwise synthesize a quantized stand-in that matches the
 * pin's meter / pickup / printedBars.
 */
export const cachedMidiPath = (entry: CorpusEntry): string | null => {
    const mov = entry.movements[0];
    if (!mov) {
        return null;
    }
    const cached = join(downloadsDir(), `${entry.slug}.mid`);
    if (existsSync(cached)) {
        return cached;
    }
    const named = join(downloadsDir(), `${entry.slug}-midi`, mov.midi);
    if (existsSync(named)) {
        return named;
    }
    return null;
};

export const midiForPin = (entry: CorpusEntry): Buffer => {
    const mov = entry.movements[0];
    if (!mov) {
        throw new Error(`${entry.slug}: no movement`);
    }
    const cached = cachedMidiPath(entry);
    if (cached !== null) {
        return readFileSync(cached);
    }
    return synthQuantizedMidi({
        meter: mov.meter,
        pickupQuarters: mov.pickupQuarters,
        printedBars: mov.printedBars,
        fifths: mov.expectedFifths,
        pitches: pitchSeed(entry.slug),
    });
};

const slugArtifactDir = (slug: string): string | null => {
    const dir = join(artifactsCacheDir(), slug);
    return existsSync(dir) ? dir : null;
};

/**
 * Bench `pdfSignals` come from the pinned PDF (and an OMR artifact when
 * `eval/cache/artifacts/<slug>/` exists). Layout bar count is never copied
 * from the pin or the candidate MIDI.
 */
export const pdfSignalsForEntry = async (entry: CorpusEntry): Promise<PdfSignals> => {
    const fetched = await fetchCorpus(entry, { allowNetwork: true, mode: 'all' });
    if (fetched.pdfPath === null) {
        throw new Error(`${entry.slug}: pinned PDF missing at eval/cache/downloads/${entry.slug}.pdf`);
    }
    const fromPdf = await pdfSignalsFromPdf(readFileSync(fetched.pdfPath));
    const artifactDir = slugArtifactDir(entry.slug);
    const artifact = artifactDir ? pdfSignalsFromArtifact(artifactDir) : null;
    return mergePdfSignals(fromPdf, artifact);
};

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

export const formatSymbolicTable = (report: SymbolicEvalReport): string => {
    const header = `${pad('id', 28)} ${pad('set', 12)} ${pad('band', 10)} ${pad('score', 7)} ${pad('reason', 18)} ${pad('layoutBars', 10)} ${pad('openingSim', 10)} ${pad('onGrid', 7)} ${pad('exact', 7)} ${pad('miss', 5)} extra`;
    const lines = [header, '-'.repeat(header.length)];
    const dash = (n: number | undefined | null, digits: number): string =>
        n === undefined || n === null ? '-' : n.toFixed(digits);
    for (const row of report.rows) {
        lines.push(
            `${pad(row.id, 28)} ${pad(row.set, 12)} ${pad(row.band, 10)} ${pad(row.score.toFixed(1), 7)} ${pad(row.reason, 18)} ${pad(dash(row.layoutBars, 0), 10)} ${pad(dash(row.openingSim, 2), 10)} ${pad(dash(row.onGrid, 1), 7)} ${pad(dash(row.exact, 1), 7)} ${pad(dash(row.missing, 0), 5)} ${dash(row.extra, 0)}`,
        );
    }
    lines.push(
        `${report.benchAccept}/${report.benchTotal} bench accept; ${report.falseAccepts}/${report.falseTotal} false accepts`,
    );
    lines.push('layoutBars is PDF vector barlines (not the pin). openingSim is null without an OMR artifact.');
    lines.push('onGrid/exact/miss/extra is compareScore provenance (not an accept predicate)');
    return `${lines.join('\n')}\n`;
};

export const matchCandidateForPin = (
    entry: CorpusEntry,
    midi: Buffer,
    workKey: WorkKey,
): MatchCandidateInput => {
    const mov = entry.movements[0];
    if (!mov) {
        throw new Error(`${entry.slug}: no movement`);
    }
    return candidateFromMidi(midi, {
        source: 'mutopia',
        format: 'mid',
        url: entry.reference.source === 'mutopia' ? entry.reference.url : '',
        sha256: entry.reference.source === 'mutopia' ? entry.reference.sha256 : sha256Hex(midi),
        workKey,
        meter: mov.meter,
        fifths: mov.expectedFifths,
        pickupQuarters: mov.pickupQuarters,
        arrangement: false,
        // Always the engraved count. Unfolded Mutopia MIDI is longer.
        printedBars: mov.printedBars,
        partialBars: mov.partialBars,
    });
};

const benchRow = async (slug: (typeof SYMBOLIC_BENCH_SLUGS)[number]): Promise<SymbolicEvalRow> => {
    const entry = loadCorpusEntry(slug);
    const workKey = requireWorkKey(entry);
    const midi = midiForPin(entry);
    const pdf = await pdfSignalsForEntry(entry);
    const cand = matchCandidateForPin(entry, midi, workKey);
    const pinBars = entry.movements[0]?.printedBars ?? 0;
    const layoutDelta = Math.abs(pdf.layoutBars - pinBars);
    if (layoutDelta > 1) {
        process.stderr.write(
            `LAYOUT DISAGREE ${slug} layoutBars=${pdf.layoutBars} pin=${pinBars} delta=${pdf.layoutBars - pinBars}\n`,
        );
    }
    const decision = decideSymbolic(pdf, [cand]);
    const log = decisionLogLine({
        uploadId: `eval:${slug}`,
        pdfSha256: entry.pdf.sha256 ?? sha256Hex(midi),
        pageCount: pdf.pageCount,
        workKey: pdf.workKey.composerId === 'unknown' ? workKey : pdf.workKey,
        match: decision.best,
        band: decision.band,
        reason: decision.reason,
    });
    const row: SymbolicEvalRow = {
        id: slug,
        set: 'bench',
        band: decision.band,
        reason: decision.reason,
        score: decision.best?.score ?? 0,
        logLine: formatDecisionLine(log),
        layoutBars: pdf.layoutBars,
        pinPrintedBars: pinBars,
        layoutDelta: pdf.layoutBars - pinBars,
        openingSim: decision.best?.signals.openingSim ?? null,
    };
    if (decision.band !== 'accept') {
        return row;
    }
    const ingested = ingestSymbolic(decision, midi, { log: () => undefined });
    const mov = entry.movements[0];
    if (!ingested.ok || !mov) {
        row.reason = 'parser_unusable';
        return row;
    }
    const compared = compareScore(
        ingested.score,
        entry,
        [notesFromMidi(midi, mov)],
        segmentMovements(ingested.score, entry),
    );
    row.onGrid = compared.overall.onGrid;
    row.exact = compared.overall.exact;
    row.missing = compared.overall.missing;
    row.extra = compared.overall.extra;
    return row;
};

export const falseMatchFixtures = async (): Promise<SymbolicEvalRow[]> => {
    if (falseMatchCache) {
        return falseMatchCache;
    }
    const rows = await buildFalseMatchFixtures();
    falseMatchCache = rows;
    return rows;
};

let falseMatchCache: SymbolicEvalRow[] | null = null;

const buildFalseMatchFixtures = async (): Promise<SymbolicEvalRow[]> => {
    const schumann = loadCorpusEntry('schumann-op68-01');
    const schKey = requireWorkKey(schumann);
    const schPdfMidi = midiForPin(schumann);
    const schPdf = await pdfSignalsForEntry(schumann);
    const soldaten = synthQuantizedMidi({
        meter: { num: 2, den: 4 },
        pickupQuarters: 0,
        printedBars: 32,
        fifths: 0,
        pitches: [62, 65, 69, 74],
    });
    const schAttack = decideSymbolic(schPdf, [
        candidateFromMidi(soldaten, {
            source: 'imslp',
            format: 'mxl',
            url: 'https://imslp.org/wiki/Special:FilePath/2._Soldatenmarsch.mxl',
            workKey: { ...schKey, movementIndex: 2 },
            meter: { num: 2, den: 4 },
            fifths: 0,
            pickupQuarters: 0,
            arrangement: false,
        }),
    ]);

    const wtc = loadCorpusEntry('wtk1-prelude1');
    const wtcKey = requireWorkKey(wtc);
    const wtcMidi = midiForPin(wtc);
    const wtcPdf = await pdfSignalsForEntry(wtc);
    const prelude2 = synthQuantizedMidi({
        meter: { num: 4, den: 4 },
        pickupQuarters: 0,
        printedBars: 38,
        fifths: -3,
        pitches: [60, 63, 67, 70],
    });
    const wtcAttack = decideSymbolic(wtcPdf, [
        candidateFromMidi(prelude2, {
            source: 'imslp',
            format: 'xml',
            url: 'https://example.test/wtc-prelude2.xml',
            workKey: { composerId: 'bach', catalogType: 'BWV', catalogN: 847, movementIndex: 2 },
            meter: { num: 4, den: 4 },
            fifths: -3,
            pickupQuarters: 0,
            arrangement: false,
        }),
    ]);

    const lute = loadCorpusEntry('bach-prelude-bwv999');
    const luteKey = requireWorkKey(lute);
    const luteMidi = midiForPin(lute);
    const lutePdf = await pdfSignalsForEntry(lute);
    const duo = synthQuantizedMidi({
        meter: { num: 3, den: 4 },
        pickupQuarters: 0,
        printedBars: 43,
        fifths: -1,
        pitches: pitchSeed('bach-prelude-bwv999'),
    });
    const duoAttack = decideSymbolic(lutePdf, [
        candidateFromMidi(duo, {
            source: 'imslp',
            format: 'mxl',
            url: 'https://imslp.org/wiki/Special:FilePath/Prelude_BWV999_lute_cello_duo.mxl',
            workKey: luteKey,
            meter: { num: 3, den: 4 },
            fifths: -1,
            pickupQuarters: 0,
            arrangement: true,
        }),
    ]);

    const perfMidi = synthQuantizedMidi({
        meter: { num: 4, den: 4 },
        pickupQuarters: 0,
        printedBars: 35,
        fifths: 0,
        pitches: pitchSeed('wtk1-prelude1'),
        onsetJitterTicks: 20,
    });
    const perfAttack = decideSymbolic(wtcPdf, [
        candidateFromMidi(perfMidi, {
            source: 'asap_eval',
            format: 'mid',
            url: 'https://example.test/asap-bwv846-performance.mid',
            workKey: wtcKey,
            meter: { num: 4, den: 4 },
            fifths: 0,
            pickupQuarters: 0,
            arrangement: false,
        }),
    ]);

    const gym = loadCorpusEntry('gymnopedie-2');
    const gymKey = requireWorkKey(gym);
    const gymMidi = midiForPin(gym);
    const gymPdf = await pdfSignalsForEntry(gym);
    const quintet = synthQuantizedMidi({
        meter: { num: 4, den: 4 },
        pickupQuarters: 0,
        printedBars: 40,
        fifths: 0,
        pitches: [55, 59, 62, 67, 71],
    });
    const quintetAttack = decideSymbolic(gymPdf, [
        candidateFromMidi(quintet, {
            source: 'imslp',
            format: 'mscz',
            url: 'https://imslp.org/wiki/Special:FilePath/Gnossienne_quintet.mscz',
            workKey: { composerId: 'satie', catalogType: 'No', catalogN: 1 },
            meter: { num: 4, den: 4 },
            fifths: 0,
            pickupQuarters: 0,
            arrangement: true,
        }),
    ]);

    const pack = (
        id: string,
        decision: ReturnType<typeof decideSymbolic>,
        uploadId: string,
        pdfSha: string,
        pageCount: number,
        workKey: WorkKey,
    ): SymbolicEvalRow => ({
        id,
        set: 'false-match',
        band: decision.band,
        reason: decision.reason,
        score: decision.best?.score ?? 0,
        openingSim: decision.best?.signals.openingSim ?? null,
        logLine: formatDecisionLine(
            decisionLogLine({
                uploadId,
                pdfSha256: pdfSha,
                pageCount,
                workKey,
                match: decision.best,
                band: decision.band,
                reason: decision.reason,
            }),
        ),
    });

    return [
        pack(
            'schumann-68-2-vs-1',
            schAttack,
            'eval:false:schumann-68-2',
            schumann.pdf.sha256 ?? sha256Hex(schPdfMidi),
            schPdf.pageCount,
            schKey,
        ),
        pack(
            'wtc-prelude-2-vs-1',
            wtcAttack,
            'eval:false:wtc-p2',
            wtc.pdf.sha256 ?? sha256Hex(wtcMidi),
            wtcPdf.pageCount,
            wtcKey,
        ),
        pack(
            'bwv999-duo',
            duoAttack,
            'eval:false:bwv999-duo',
            lute.pdf.sha256 ?? sha256Hex(luteMidi),
            lutePdf.pageCount,
            luteKey,
        ),
        pack(
            'bwv846-performance-midi',
            perfAttack,
            'eval:false:bwv846-perf',
            wtc.pdf.sha256 ?? sha256Hex(wtcMidi),
            wtcPdf.pageCount,
            wtcKey,
        ),
        pack(
            'gnossienne-quintet',
            quintetAttack,
            'eval:false:quintet',
            gym.pdf.sha256 ?? sha256Hex(gymMidi),
            gymPdf.pageCount,
            gymKey,
        ),
    ];
};

export const runSymbolicEval = async (): Promise<SymbolicEvalReport> => {
    const bench = [];
    for (const slug of SYMBOLIC_BENCH_SLUGS) {
        bench.push(await benchRow(slug));
    }
    const attacks = await falseMatchFixtures();
    const rows = [...bench, ...attacks];
    return {
        rows,
        benchAccept: bench.filter((r) => r.band === 'accept').length,
        benchTotal: bench.length,
        falseAccepts: attacks.filter((r) => r.band === 'accept').length,
        falseTotal: attacks.length,
    };
};
