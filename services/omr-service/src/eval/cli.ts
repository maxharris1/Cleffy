import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { fromArtifacts, fromDocument, fromPdf, type Candidate } from './candidate.js';
import { compareScore } from './compare.js';
import { fetchCorpus, midiPath } from './fetch.js';
import { loadCorpusEntry } from './manifest.js';
import { notesFromMidi } from './midiRef.js';
import { attachRecord, diffBaseline, formatDeltas, formatSummary, loadBaseline, writeResult } from './report.js';
import { segmentMovements } from './segment.js';

const usage = `Usage:
  node dist/eval/cli.js fetch --piece <slug>
  node dist/eval/cli.js audiveris --piece <slug> [--force-audiveris]
  node dist/eval/cli.js run --piece <slug> --from pdf|artifacts <dir>|document <id>
       [--baseline <json>] [--out <filename>] [--tolerance 0.5] [--force-audiveris] [--json]
`;

const fail = (message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const loadRefs = async (entry: ReturnType<typeof loadCorpusEntry>, midiDir: string) => {
    const refs = [];
    for (const movement of entry.movements) {
        const buf = await readFile(midiPath({ pdfPath: null, midiDir }, movement.midi));
        refs.push(notesFromMidi(buf, movement));
    }
    return refs;
};

const runCompare = async (
    entry: ReturnType<typeof loadCorpusEntry>,
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
    const deltas = diffBaseline(loadBaseline(baselinePath), record, tolerance);
    process.stdout.write(`${formatDeltas(deltas)}\n`);
    return deltas.some((d) => d.regressed) ? 1 : 0;
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
            'force-audiveris': { type: 'boolean', default: false },
        },
    });
    const command = positionals[0];
    const slug = values.piece;
    if (command === undefined || slug === undefined) {
        return fail(usage);
    }
    const entry = loadCorpusEntry(slug);
    const tolerance = Number(values.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0) {
        return fail('--tolerance must be a non-negative number');
    }

    switch (command) {
        case 'fetch': {
            const fetched = await fetchCorpus(entry);
            process.stdout.write(`midi ${fetched.midiDir}\npdf ${fetched.pdfPath ?? '(missing)'}\n`);
            return 0;
        }
        case 'audiveris': {
            const fetched = await fetchCorpus(entry);
            const pdfPath = fetched.pdfPath;
            if (pdfPath === null) {
                return fail('PDF is not in the cache; fetch it or copy the file into eval/cache/downloads/<slug>.pdf');
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
                return fail('--from pdf | artifacts <dir> | document <id>');
            }
            const fetched = await fetchCorpus(entry);
            let candidate: Candidate;
            if (from === 'pdf') {
                const pdfPath = fetched.pdfPath;
                if (pdfPath === null) {
                    return fail(
                        'PDF is not in the cache; fetch it or copy the file into eval/cache/downloads/<slug>.pdf',
                    );
                }
                candidate = await fromPdf(pdfPath, values['force-audiveris'] === true);
            } else if (from === 'artifacts') {
                const dir = positionals[1];
                if (dir === undefined) {
                    return fail('--from artifacts requires a directory argument');
                }
                candidate = await fromArtifacts(dir);
            } else if (from === 'document') {
                const id = positionals[1];
                if (id === undefined) {
                    return fail('--from document requires a document UUID');
                }
                candidate = await fromDocument(id);
            } else {
                return fail(`unknown --from ${from}`);
            }
            return runCompare(
                entry,
                candidate,
                fetched.midiDir,
                values.json === true,
                values.baseline,
                values.out,
                tolerance,
            );
        }
        default:
            return fail(usage);
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
