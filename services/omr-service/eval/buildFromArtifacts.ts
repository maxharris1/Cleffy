import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { discoverOutputs } from '../src/audiveris.js';
import { buildScoreData } from '../src/buildScoreData.js';
import type { Era } from '../src/era.js';
import { parseMxlFiles } from '../src/musicxml.js';
import { parseOmrGeometry } from '../src/omrGeometry.js';

/**
 * ScoreData from an Audiveris output directory (the .mxl files and the .omr),
 * exactly as the serial job path builds it:
 *
 *   npx tsx eval/buildFromArtifacts.ts --dir out/ [--era classical] [--out score.json]
 *
 * This is how the eval harness is fed when the score is not in a database:
 * run Audiveris on the PDF (see eval/README.md), build, compare.
 */

const argValue = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at >= 0 ? process.argv[at + 1] : undefined;
};

const ERAS: ReadonlySet<string> = new Set(['baroque', 'classical', 'romantic', 'modern']);

const main = async (): Promise<void> => {
    const dir = argValue('--dir');
    if (!dir) {
        console.error('usage: buildFromArtifacts.ts --dir <audiveris output dir> [--era classical] [--out score.json]');
        process.exit(2);
    }
    const eraArg = argValue('--era') ?? 'classical';
    if (!ERAS.has(eraArg)) {
        console.error(`unknown era ${eraArg}`);
        process.exit(2);
    }
    const era = eraArg as Era;
    const outputs = await discoverOutputs(resolve(dir));
    if (outputs.mxlPaths.length === 0) {
        console.error(`no .mxl under ${dir}`);
        process.exit(2);
    }
    const mxlBuffers = outputs.mxlPaths.map((path) => readFileSync(path));
    const geometry = outputs.omrPath ? parseOmrGeometry(readFileSync(outputs.omrPath)) : null;
    const musical = parseMxlFiles(mxlBuffers, undefined, { era });
    const score = buildScoreData(musical, geometry, { era });
    const json = JSON.stringify(score);
    const out = argValue('--out');
    if (out) {
        writeFileSync(out, json);
        console.error(
            `${outputs.mxlPaths.length} movement file(s), ${score.notes.length} notes, ${score.measures.length} measures, warnings: ${score.warnings.join(', ')}`,
        );
    } else {
        process.stdout.write(json);
    }
};

void main();
