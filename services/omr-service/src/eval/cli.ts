import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { fromArtifacts, fromDocument, fromPdf, fromScoreFile, type Candidate } from './candidate.js';
import { compareScore } from './compare.js';
import { fetchCorpus, midiPath } from './fetch.js';
import { loadCorpusEntry, type CorpusEntry } from './manifest.js';
import { notesFromMidi } from './midiRef.js';
import {
    attachRecord,
    diffBaseline,
    formatDeltas,
    formatSummary,
    IncomparableBaselineError,
    loadBaseline,
    writeResult,
} from './report.js';
import { segmentMovements } from './segment.js';
import {
    compareShootout,
    fetchProdShootout,
    formatShootout,
    runLocalShootout,
    shootoutScorePath,
} from './shootout.js';

const usage = `Usage:
  node dist/eval/cli.js fetch --piece <slug>
  node dist/eval/cli.js audiveris --piece <slug> [--force-audiveris]
  node dist/eval/cli.js run --piece <slug> --from pdf|artifacts <dir>|document <id>|score <file>
       [--baseline <json>] [--out <filename>] [--tolerance 0.5] [--force-audiveris] [--json]
  node dist/eval/cli.js shootout fetch --piece <slug> --document <uuid>
  node dist/eval/cli.js shootout local --piece <slug> [--force-audiveris]
  node dist/eval/cli.js shootout compare --piece <slug> [--prod <score.json>] [--local <score.json>]

  node dist/eval/cli.js --help

CI runs eval unit tests (including this CLI on a committed toy fixture). It does
not run Audiveris or score Moonlight. A green omr-service job is not an accuracy
gate for corpus pieces that need the engine.

--from document cannot --out a baseline-* file. Commit a baseline only from
--from artifacts with a non-null artifactHash.

Shootout: same PDF bytes, hosted ScoreData vs current engine, one MIDI eval.
fetch is hosted read-only (project jibgwgosihadbjgxdsfe). local needs cleffy-omr.
Cloud agents without Audiveris may fetch + compare once both score.json files exist.
`;

type Command = 'fetch' | 'audiveris' | 'run' | 'shootout' | 'help';
type ShootoutSub = 'fetch' | 'local' | 'compare';

const fail = (message: string, code = 1): never => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

const asCommand = (raw: string | undefined): Command | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    switch (raw) {
        case 'fetch':
        case 'audiveris':
        case 'run':
        case 'shootout':
        case 'help':
            return raw;
        default:
            return undefined;
    }
};

const loadRefs = async (entry: CorpusEntry, midiDir: string) => {
    const refs = [];
    for (const movement of entry.movements) {
        const buf = await readFile(midiPath({ pdfPath: null, midiDir }, movement.midi));
        refs.push(notesFromMidi(buf, movement));
    }
    return refs;
};

const runCompare = async (
    entry: CorpusEntry,
    candidate: Candidate,
    midiDir: string,
    jsonOnly: boolean,
    baselinePath: string | undefined,
    outName: string | undefined,
    tolerance: number,
): Promise<number> => {
    const refs = await loadRefs(entry, midiDir);
    const segmented = segmentMovements(candidate.score, entry);
    const result = compareScore(candidate.score, entry, refs, segmented);
    const record = attachRecord(result, candidate);
    const written = await writeResult(record, outName);
    if (jsonOnly) {
        process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
        process.stdout.write(`${formatSummary(record)}\nwrote ${written}\n`);
    }
    if (!baselinePath) {
        return 0;
    }
    try {
        const deltas = diffBaseline(loadBaseline(baselinePath), record, tolerance);
        process.stdout.write(`${formatDeltas(deltas)}\n`);
        return deltas.some((d) => d.regressed) ? 1 : 0;
    } catch (err) {
        if (err instanceof IncomparableBaselineError) {
            process.stderr.write(`${err.message}\n`);
            return err.exitCode;
        }
        throw err;
    }
};

const main = async (): Promise<number> => {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            piece: { type: 'string' },
            from: { type: 'string' },
            baseline: { type: 'string' },
            out: { type: 'string' },
            tolerance: { type: 'string', default: '0.5' },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            'force-audiveris': { type: 'boolean', default: false },
            document: { type: 'string' },
            prod: { type: 'string' },
            local: { type: 'string' },
        },
    });
    if (values.help === true) {
        process.stdout.write(usage);
        return 0;
    }
    const command = asCommand(positionals[0]);
    const slug = values.piece;
    if (command === undefined || (command !== 'help' && slug === undefined)) {
        return fail(usage);
    }
    if (command === 'help') {
        process.stdout.write(usage);
        return 0;
    }
    if (slug === undefined) {
        return fail(usage);
    }
    const entry = loadCorpusEntry(slug);
    const tolerance = Number(values.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0) {
        return fail('--tolerance must be a non-negative number');
    }

    switch (command) {
        case 'fetch': {
            const fetched = await fetchCorpus(entry, { allowNetwork: true, mode: 'all' });
            process.stdout.write(`midi ${fetched.midiDir}\npdf ${fetched.pdfPath ?? '(missing)'}\n`);
            return 0;
        }
        case 'audiveris': {
            const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'all' });
            const pdfPath = fetched.pdfPath;
            if (entry.pdf.sha256 === undefined) {
                return fail('pdf.sha256 is required before --from pdf / audiveris; pin the file you actually scored');
            }
            if (pdfPath === null) {
                return fail('PDF is not in the cache; copy the pinned file into eval/cache/downloads/<slug>.pdf');
            }
            const candidate = await fromPdf(pdfPath, values['force-audiveris'] === true);
            process.stdout.write(
                `artifacts ${candidate.artifactDir}\ncacheHit ${candidate.audiverisCacheHit}\nversion ${candidate.audiverisVersion}\n`,
            );
            return 0;
        }
        case 'run': {
            const from = values.from;
            if (from === undefined) {
                return fail('--from pdf | artifacts <dir> | document <id> | score <file>');
            }
            let candidate: Candidate;
            let midiDir: string;
            if (from === 'pdf') {
                if (entry.pdf.sha256 === undefined) {
                    return fail(
                        'pdf.sha256 is required before --from pdf; pin the file you actually scored',
                    );
                }
                const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'all' });
                const pdfPath = fetched.pdfPath;
                if (pdfPath === null) {
                    return fail(
                        'PDF is not in the cache; copy the pinned file into eval/cache/downloads/<slug>.pdf',
                    );
                }
                candidate = await fromPdf(pdfPath, values['force-audiveris'] === true);
                midiDir = fetched.midiDir;
            } else if (from === 'artifacts') {
                const dir = positionals[1];
                if (dir === undefined) {
                    return fail('--from artifacts requires a directory argument');
                }
                const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'midi' });
                candidate = await fromArtifacts(dir);
                midiDir = fetched.midiDir;
            } else if (from === 'document') {
                const id = positionals[1];
                if (id === undefined) {
                    return fail('--from document requires a document UUID');
                }
                const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'midi' });
                candidate = await fromDocument(id);
                midiDir = fetched.midiDir;
            } else if (from === 'score') {
                const scorePath = positionals[1];
                if (scorePath === undefined) {
                    return fail('--from score requires a path to score.json');
                }
                const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'midi' });
                candidate = await fromScoreFile(scorePath);
                midiDir = fetched.midiDir;
            } else {
                return fail(`unknown --from ${from}`);
            }
            return runCompare(
                entry,
                candidate,
                midiDir,
                values.json === true,
                values.baseline,
                values.out,
                tolerance,
            );
        }
        case 'shootout': {
            const subRaw = positionals[1];
            const sub: ShootoutSub | undefined =
                subRaw === 'fetch' || subRaw === 'local' || subRaw === 'compare' ? subRaw : undefined;
            if (sub === undefined) {
                return fail('shootout fetch | local | compare');
            }
            switch (sub) {
                case 'fetch': {
                    const documentId = values.document;
                    if (documentId === undefined) {
                        return fail('shootout fetch requires --document <uuid>');
                    }
                    const dest = await fetchProdShootout(entry, documentId);
                    process.stdout.write(`prod ${dest}\n`);
                    return 0;
                }
                case 'local': {
                    const dest = await runLocalShootout(entry, values['force-audiveris'] === true);
                    process.stdout.write(`local ${dest}\n`);
                    return 0;
                }
                case 'compare': {
                    const prodPath = values.prod ?? shootoutScorePath(entry.slug, 'prod');
                    const localPath = values.local ?? shootoutScorePath(entry.slug, 'local');
                    const { report, outDir } = await compareShootout(entry, prodPath, localPath);
                    if (values.json === true) {
                        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
                    } else {
                        process.stdout.write(`${formatShootout(report)}wrote ${outDir}\n`);
                    }
                    if (report.pdfIdentical === true) {
                        return 0;
                    }
                    return 2;
                }
                default: {
                    const exhaustive: never = sub;
                    return fail(`unknown shootout ${exhaustive}`);
                }
            }
        }
        default: {
            const exhaustive: never = command;
            return fail(`unknown command ${exhaustive}`);
        }
    }
};

main()
    .then((code) => {
        process.exit(code);
    })
    .catch((err: unknown) => {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
