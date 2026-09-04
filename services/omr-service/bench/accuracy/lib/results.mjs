import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RAW_RESULTS_DIR } from './paths.mjs';

export const resultPath = (engine, scoreId) => join(RAW_RESULTS_DIR, engine, `${scoreId}.json`);

export const writeResult = async (engine, scoreId, result) => {
    await mkdir(join(RAW_RESULTS_DIR, engine), { recursive: true });
    await writeFile(resultPath(engine, scoreId), JSON.stringify(result, null, 1));
};

export const readResult = async (engine, scoreId) => {
    try {
        return JSON.parse(await readFile(resultPath(engine, scoreId), 'utf8'));
    } catch {
        return null;
    }
};

export const listEngines = async () => {
    try {
        return (await readdir(RAW_RESULTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return [];
    }
};

/** Compact transcript stored with each result so metrics can be recomputed offline. */
export const toTranscript = (musical) => ({
    notes: musical.notes.map((n) => ({ t: n.t, d: n.d, p: n.p, h: n.h })),
    measures: musical.measures.map((m) => ({ n: m.n, tick: m.tick, dTicks: m.dTicks })),
    totalTicks: musical.totalTicks,
    timeSignatures: musical.timeSignatures,
    keySignatures: musical.keySignatures,
    repeats: {
        forward: musical.repeats.filter((r) => r.repeatForward).length,
        backward: musical.repeats.filter((r) => r.repeatBackward).length,
        endings: musical.repeats.filter((r) => r.endingStart).length,
    },
    warnings: musical.warnings,
});
