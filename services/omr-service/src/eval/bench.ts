import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENGINE_VERSION } from '../job.js';
import { fromPdf, optionsFingerprint, type Candidate } from './candidate.js';
import { compareScore, type EvalResult } from './compare.js';
import { fetchCorpus, midiPath } from './fetch.js';
import { loadCorpusEntry, type CorpusEntry } from './manifest.js';
import { notesFromMidi } from './midiRef.js';
import { resultsDir } from './paths.js';
import { playAlongGate, type PlayAlongLimits, type PlayAlongVerdict } from './playAlong.js';
import { segmentMovements } from './segment.js';

/**
 * The pinned play-along benchmark suite, in difficulty order.
 *
 * Every entry is a Mutopia LilyPond edition whose PDF, MIDI and `.ly` come from
 * one source and are sha256-pinned, so `bench` re-runs byte-identically on any
 * later version of the branch. `toy` and `moonlight` are deliberately excluded:
 * `toy` is a CI fixture and not a musicality claim, and Moonlight's reference
 * PDF is a hand-vendored IMSLP extract that cannot be fetched.
 */
export const BENCH_SUITE = [
    // Baroque keyboard: the printed grid with nothing else going on.
    'czerny-op821-01',
    'bach-prelude-bwv939',
    'bach-air-anh131',
    'bach-invention-01',
    'bach-invention-08',
    'bach-prelude-bwv999',
    'wtk1-prelude1',
    // Repeats and voltas.
    'anna-magdalena-04',
    'anna-magdalena-05',
    'anna-magdalena-07',
    'burgmuller-op100-02',
    // Pickups, and a reference that unfolds its own repeats.
    'schumann-op68-01',
    'schumann-op68-05',
    // Wider textures and the hard cases.
    'gymnopedie-2',
    'fur-elise-mutopia',
    'chopin-prelude-4',
] as const;

export interface BenchPiece {
    slug: string;
    title: string;
    pages: number;
    pdfSha256: string | null;
    referenceSha256: string | null;
    artifactHash: string | null;
    refNotes: number;
    pitchMatch: number;
    exact: number;
    onGrid: number;
    missing: number;
    extra: number;
    composite: number;
    pass: boolean;
    failures: string[];
}

export interface BenchReport {
    generatedAt: string;
    engineVersion: string;
    audiverisVersion: string | null;
    audiverisOptions: string;
    limits: PlayAlongLimits;
    /** Reference-note-weighted means across the suite. */
    totals: {
        pieces: number;
        piecesPassed: number;
        refNotes: number;
        pitchMatch: number;
        exact: number;
        onGrid: number;
        missing: number;
        extra: number;
    };
    pieces: BenchPiece[];
}

const loadRefs = async (entry: CorpusEntry, midiDir: string) => {
    const refs = [];
    for (const movement of entry.movements) {
        const buf = await readFile(midiPath({ pdfPath: null, midiDir }, movement.midi));
        refs.push(notesFromMidi(buf, movement));
    }
    return refs;
};

export interface BenchOptions {
    limits: PlayAlongLimits;
    /** Re-run Audiveris instead of reusing the artifact cache. */
    forceAudiveris: boolean;
    /** Slugs to score; defaults to `BENCH_SUITE`. */
    slugs?: readonly string[];
}

export const scoreOnePiece = async (
    slug: string,
    options: BenchOptions,
): Promise<{ entry: CorpusEntry; candidate: Candidate; result: EvalResult; verdict: PlayAlongVerdict }> => {
    const entry = loadCorpusEntry(slug);
    if (entry.pdf.sha256 === undefined) {
        throw new Error(`${slug}: pdf.sha256 is required in the benchmark suite — pin the file you scored`);
    }
    // Network is allowed here on purpose: the whole point of the suite is that a
    // clean checkout can reproduce it, and every byte is hash-pinned on the way in.
    const fetched = await fetchCorpus(entry, { allowNetwork: true, mode: 'all' });
    if (fetched.pdfPath === null) {
        throw new Error(
            `${slug}: the pinned PDF is not available. Fetch it by hand into eval/cache/downloads/${slug}.pdf`,
        );
    }
    const candidate = await fromPdf(fetched.pdfPath, options.forceAudiveris);
    const refs = await loadRefs(entry, fetched.midiDir);
    const result = compareScore(candidate.score, entry, refs, segmentMovements(candidate.score, entry));
    return { entry, candidate, result, verdict: playAlongGate(result, options.limits) };
};

export const runBench = async (options: BenchOptions): Promise<BenchReport> => {
    const slugs = options.slugs ?? BENCH_SUITE;
    const pieces: BenchPiece[] = [];
    let audiverisVersion: string | null = null;
    let refNotes = 0;
    let pitchWeighted = 0;
    let exactWeighted = 0;
    let onGridWeighted = 0;
    let missing = 0;
    let extra = 0;

    for (const slug of slugs) {
        process.stderr.write(`bench: ${slug}\n`);
        const { entry, candidate, result, verdict } = await scoreOnePiece(slug, options);
        audiverisVersion ??= candidate.audiverisVersion;
        pieces.push({
            slug,
            title: entry.title,
            pages: entry.pdf.pages,
            pdfSha256: entry.pdf.sha256 ?? null,
            referenceSha256: entry.reference.source === 'mutopia' ? entry.reference.sha256 : null,
            artifactHash: candidate.artifactHash,
            refNotes: result.overall.refNotes,
            pitchMatch: result.overall.pitchMatch,
            exact: result.overall.exact,
            onGrid: result.overall.onGrid,
            missing: result.overall.missing,
            extra: result.overall.extra,
            composite: result.composite,
            pass: verdict.pass,
            failures: verdict.failures,
        });
        refNotes += result.overall.refNotes;
        pitchWeighted += result.overall.pitchMatch * result.overall.refNotes;
        exactWeighted += result.overall.exact * result.overall.refNotes;
        onGridWeighted += result.overall.onGrid * result.overall.refNotes;
        missing += result.overall.missing;
        extra += result.overall.extra;
    }

    const safe = Math.max(1, refNotes);
    return {
        generatedAt: new Date().toISOString(),
        engineVersion: ENGINE_VERSION,
        audiverisVersion,
        audiverisOptions: optionsFingerprint(),
        limits: options.limits,
        totals: {
            pieces: pieces.length,
            piecesPassed: pieces.filter((p) => p.pass).length,
            refNotes,
            // Weighted by reference notes, not by piece: a 905-note Für Elise and
            // a 199-note minuet are not equal evidence about the engine.
            pitchMatch: pitchWeighted / safe,
            exact: exactWeighted / safe,
            onGrid: onGridWeighted / safe,
            missing,
            extra,
        },
        pieces,
    };
};

const pct = (n: number): string => `${n.toFixed(1)}%`;

export const formatBench = (report: BenchReport): string => {
    const lines = [
        '# OMR play-along benchmark',
        '',
        `engine: ${report.engineVersion}  audiveris: ${report.audiverisVersion ?? '—'}`,
        `audiveris options: \`${report.audiverisOptions}\``,
        `generated: ${report.generatedAt}`,
        `gate floors: exact ≥ ${pct(report.limits.exactFloor)}, onGrid ≥ ${pct(report.limits.onGridFloor)}, ` +
            `1 missed/extra note allowed per ${report.limits.barsPerAllowedMiss} printed bars`,
        '',
        `**Play-along score ${pct(report.totals.onGrid)}** · ${report.totals.piecesPassed}/${report.totals.pieces} pieces pass the gate`,
        '',
        'Rates are weighted by reference notes, not by piece. A piece whose `meters`',
        'check failed could not bind a tick slice, so its rates are void rather than',
        'measured — read its failure list, not its percentages.',
        '',
        '| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ];
    for (const piece of report.pieces) {
        lines.push(
            `| ${piece.title} | ${piece.pages} | ${piece.refNotes} | ${pct(piece.pitchMatch)} | ${pct(piece.exact)} | ` +
                `${pct(piece.onGrid)} | ${piece.missing} | ${piece.extra} | ${piece.composite.toFixed(1)} | ${piece.pass ? 'pass' : 'FAIL'} |`,
        );
    }
    lines.push(
        `| **suite** | | **${report.totals.refNotes}** | **${pct(report.totals.pitchMatch)}** | **${pct(report.totals.exact)}** | ` +
            `**${pct(report.totals.onGrid)}** | **${report.totals.missing}** | **${report.totals.extra}** | | ` +
            `**${report.totals.piecesPassed}/${report.totals.pieces}** |`,
        '',
    );
    for (const piece of report.pieces) {
        if (piece.failures.length === 0) {
            continue;
        }
        lines.push(`## ${piece.title} — ${piece.failures.length} failed check(s)`, '');
        for (const failure of piece.failures) {
            lines.push(`- ${failure}`);
        }
        lines.push('');
    }
    return lines.join('\n');
};

/** Writes `eval/results/bench/{bench.json,bench.md}` and returns the directory. */
export const writeBench = async (report: BenchReport): Promise<string> => {
    const dir = join(resultsDir(), 'bench');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bench.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(dir, 'bench.md'), formatBench(report));
    return dir;
};
