import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TICKS_PER_QUARTER } from '../scoreData.js';
import { parseMxlFiles, parseMusicXmlString, type MusicalScore } from '../musicxml.js';
import { fifthsViaLibrary, OPENING_BARS, type Meter, type PdfSignals } from './signals.js';
import type { BarNote } from '../eval/compare.js';
import { pdfLayoutFromBytes, type BarBox } from './pdfLayout.js';
import { fifthsFromPdfLayout, meterFromPdfLayout, workKeyFromPdfLayout } from './pdfText.js';
import type { WorkKey } from './types.js';

export interface ArtifactSignals {
    meter: Meter;
    fifths: number | null;
    measureCount: number;
    opening: BarNote[][];
}

const walkFiles = (dir: string, depth = 0): string[] => {
    if (depth > 4 || !existsSync(dir)) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(full, depth + 1) : [full];
    });
};

const openingFromMusical = (musical: MusicalScore): BarNote[][] => {
    const bars = musical.measures.slice(0, OPENING_BARS);
    return bars.map((measure) =>
        musical.notes
            .filter((n) => n.t >= measure.tick && n.t < measure.tick + measure.dTicks)
            .map((n): BarNote => ({
                onsetQ: (n.t - measure.tick) / TICKS_PER_QUARTER,
                pitch: n.p,
                durQ: n.d / TICKS_PER_QUARTER,
                hand: n.h,
            })),
    );
};

const unknownWorkKey = (): WorkKey => ({ composerId: 'unknown', catalogType: 'Op', catalogN: 0 });

export const pdfSignalsFromPdf = async (pdfBytes: Uint8Array | Buffer): Promise<PdfSignals> => {
    const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    const layout = await pdfLayoutFromBytes(bytes);
    const workKey = workKeyFromPdfLayout(layout) ?? unknownWorkKey();
    return {
        meter: meterFromPdfLayout(layout),
        fifths: fifthsFromPdfLayout(layout),
        printedBars: layout.printedBars,
        // The page gives only `pickupFlagged` (first-box width includes the
        // clef/key/meter, so it cannot size the pickup). MIDI candidates read the
        // length from their own downbeats (fingerprint.ts `pickupOf`).
        pickupQuarters: 0,
        opening: null,
        workKey,
        pageCount: layout.pageCount,
        pickupFlagged: layout.pickupFlagged,
        layoutBars: layout.printedBars,
        barBoxes: layout.boxes,
    };
};

export const pdfSignalsFromArtifact = (artifactDir: string): ArtifactSignals => {
    const files = walkFiles(artifactDir);
    const mxl = files.filter((f) => f.toLowerCase().endsWith('.mxl')).sort();
    const xml = files.filter((f) => /\.(xml|musicxml)$/i.test(f)).sort();
    const chosen = mxl.length > 0 ? mxl : xml;
    if (chosen.length === 0) {
        throw new Error(`no MusicXML under ${artifactDir}`);
    }
    const buffers = chosen.map((f) => readFileSync(f));
    const first = buffers[0];
    const looksLikeZip = first !== undefined && first.length >= 2 && first[0] === 0x50 && first[1] === 0x4b;
    const musical =
        buffers.length === 1 && first !== undefined && !looksLikeZip
            ? parseMusicXmlString(first.toString('utf8'))
            : parseMxlFiles(buffers);
    const ts = musical.timeSignatures[0];
    const ks = musical.keySignatures[0];
    return {
        meter: { num: ts?.num ?? 4, den: ts?.den ?? 4 },
        fifths: ks === undefined ? null : fifthsViaLibrary(ks.fifths),
        measureCount: musical.measures.length,
        opening: openingFromMusical(musical),
    };
};

export const mergePdfSignals = (fromPdf: PdfSignals, artifact: ArtifactSignals | null): PdfSignals => {
    const fifths = artifact?.fifths ?? fromPdf.fifths;
    const meter = fromPdf.meter ?? artifact?.meter ?? null;
    const opening = artifact ? artifact.opening : null;
    return {
        ...fromPdf,
        meter,
        fifths,
        opening,
        printedBars: fromPdf.layoutBars,
    };
};

export type { BarBox };
