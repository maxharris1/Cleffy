/**
 * Baseline engines: Audiveris <version> inside its cleffy-omr Docker image,
 * driven by the production `runAudiveris` (dist/audiveris.js) through the
 * `audiveris-docker.sh` shim, then the production parse + buildScoreData.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DIST_DIR } from '../paths.mjs';

const dist = (name) => import(join(DIST_DIR, name));

export const AUDIVERIS_IMAGES = {
    'audiveris-5.6.1': 'cleffy-omr:5.6.1',
    'audiveris-5.11.0': 'cleffy-omr:5.11.0-bench',
};

/**
 * @returns {{ musical, scoreData, geometry, audiveris, wallMs, mxlCount, omrBytes }}
 */
export const runAudiverisEngine = async ({ image, pdfPath, workDir, timeoutMs = 20 * 60_000, sheets }) => {
    const [{ runAudiveris }, { parseMxlFiles }, { parseOmrGeometry }, { buildScoreData }] = await Promise.all([
        dist('audiveris.js'),
        dist('musicxml.js'),
        dist('omrGeometry.js'),
        dist('buildScoreData.js'),
    ]);
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, '.image'), image);
    const outDir = join(workDir, 'out');
    await mkdir(outDir, { recursive: true });

    const started = Date.now();
    const audiveris = await runAudiveris(pdfPath, outDir, { timeoutMs, sheets });
    const audiverisWallMs = Date.now() - started;

    const parseStarted = Date.now();
    const mxls = await Promise.all(audiveris.mxlPaths.map((p) => readFile(p)));
    const musical = parseMxlFiles(mxls);
    const omrBytes = audiveris.omrPath ? await readFile(audiveris.omrPath) : null;
    const geometry = omrBytes ? parseOmrGeometry(omrBytes) : null;
    const scoreData = buildScoreData(musical, geometry);
    const parseMs = Date.now() - parseStarted;

    return {
        musical,
        scoreData,
        geometry,
        omrPath: audiveris.omrPath,
        timings: {
            wallMs: audiverisWallMs + parseMs,
            audiverisMs: audiverisWallMs,
            parseMs,
            jvmStartToFirstSheetMs: audiveris.jvmStartToFirstSheetMs,
            perSheetMs: audiveris.perSheetMs,
            stepDurationsMs: audiveris.stepDurationsMs,
        },
        mxlCount: audiveris.mxlPaths.length,
    };
};
