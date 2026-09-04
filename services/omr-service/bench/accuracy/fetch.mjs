#!/usr/bin/env node
/**
 * Build the benchmark corpus described in manifest.json under data/:
 *   data/gt/<asap path>.musicxml   ground-truth MusicXML (ASAP dataset)
 *   data/pdf/<id>.pdf              the PDF each engine is run on
 *   data/pdf/<id>.mpos             MuseScore measure boxes (typeset only)
 *   data/imslp/<file>              raw IMSLP downloads (cached)
 * Idempotent: existing files are kept unless --force.
 */
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { downloadImslpPdf } from './lib/imslp.mjs';
import { musescoreExport, pdfConcat, pdfExtractPages, pdfPageCount } from './lib/pdf.mjs';
import { GT_DIR, IMSLP_DIR, MANIFEST_PATH, PDF_DIR } from './lib/paths.mjs';

const { values } = parseArgs({
    options: {
        force: { type: 'boolean', default: false },
        scores: { type: 'string' },
    },
});

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const only = values.scores ? new Set(values.scores.split(',')) : null;
const scores = manifest.scores.filter((s) => !only || only.has(s.id));

const exists = async (p) => {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
};

await mkdir(GT_DIR, { recursive: true });
await mkdir(PDF_DIR, { recursive: true });
await mkdir(IMSLP_DIR, { recursive: true });

export const gtPath = (asapPath) => join(GT_DIR, `${asapPath.replace(/[/.]/g, '_')}.musicxml`);

const fetchGt = async (asapPath) => {
    const out = gtPath(asapPath);
    if (!values.force && (await exists(out))) {
        return out;
    }
    const url = `${manifest.asapBase}/${asapPath}/xml_score.musicxml`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
        throw new Error(`GT download failed ${res.status}: ${url}`);
    }
    const xml = await res.text();
    if (!xml.includes('<score-partwise')) {
        throw new Error(`Not MusicXML: ${url}`);
    }
    await writeFile(out, xml);
    console.log(`  gt   ${asapPath}`);
    return out;
};

const imslpRaw = async (file) => {
    const out = join(IMSLP_DIR, file.replace(/[^A-Za-z0-9._-]+/g, '_'));
    if (!values.force && (await exists(out))) {
        return out;
    }
    console.log(`  imslp ${file}`);
    const bytes = await downloadImslpPdf(file);
    await writeFile(out, bytes);
    return out;
};

// Two passes so `concat` entries can rely on their inputs.
const ordered = [...scores.filter((s) => s.pdf.type !== 'concat'), ...scores.filter((s) => s.pdf.type === 'concat')];

for (const score of ordered) {
    console.log(`[${score.id}]`);
    const gts = await Promise.all(score.gt.map(fetchGt));
    const pdfOut = join(PDF_DIR, `${score.id}.pdf`);
    if (!values.force && (await exists(pdfOut))) {
        console.log(`  pdf  cached (${await pdfPageCount(pdfOut)} pages)`);
        continue;
    }
    switch (score.pdf.type) {
        case 'render': {
            if (gts.length !== 1) {
                throw new Error(`${score.id}: render needs exactly one gt`);
            }
            await musescoreExport(gts[0], pdfOut);
            await musescoreExport(gts[0], join(PDF_DIR, `${score.id}.mpos`));
            break;
        }
        case 'imslp': {
            const raw = await imslpRaw(score.pdf.file);
            if (score.pdf.pages) {
                await pdfExtractPages(raw, score.pdf.pages[0], score.pdf.pages[1], pdfOut);
            } else {
                await copyFile(raw, pdfOut);
            }
            break;
        }
        case 'concat': {
            await pdfConcat(
                score.pdf.of.map((id) => join(PDF_DIR, `${id}.pdf`)),
                pdfOut,
            );
            break;
        }
        default:
            throw new Error(`${score.id}: unknown pdf type ${score.pdf.type}`);
    }
    console.log(`  pdf  ${await pdfPageCount(pdfOut)} pages`);
}
console.log('done');
