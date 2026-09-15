import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { midiForPin } from './evalRun.js';
import { decisionLogLine, formatDecisionLine, SYMBOLIC_TIER } from './log.js';
import { symbolicMatchScore } from './match.js';
import { candidateFromMidi, pdfSignalsFromPin } from './signals.js';
import { workKeyFromText } from './workKey.js';

describe('symbolic decision log', () => {
    it('emits one JSON line with the locked §2 fields', () => {
        const entry = loadCorpusEntry('bach-invention-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = candidateFromMidi(midi, {
            source: 'mutopia',
            format: 'mid',
            url: entry.reference.source === 'mutopia' ? entry.reference.url : '',
            sha256: entry.reference.source === 'mutopia' ? entry.reference.sha256 : undefined,
            workKey,
            meter: pdf.meter,
            fifths: pdf.fifths,
            pickupQuarters: pdf.pickupQuarters,
            arrangement: false,
        });
        const match = symbolicMatchScore(pdf, cand);
        const line = decisionLogLine({
            uploadId: 'u1',
            pdfSha256: entry.pdf.sha256 ?? '0'.repeat(64),
            pageCount: pdf.pageCount,
            workKey,
            imslpPageTitle: 'Inventions, BWV 772–786 (Bach, Johann Sebastian)',
            match,
            band: match.band,
            reason: match.reason,
            timestamp: '2026-09-15T00:00:00.000Z',
            gitSha: 'deadbeef',
        });
        expect(line.symbolicTier).toBe(SYMBOLIC_TIER);
        expect(line.engineSkipped).toBe(true);
        expect(line.uploadId).toBe('u1');
        expect(line.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(line.pageCount).toBe(entry.pdf.pages);
        expect(line.workKey.catalogN).toBe(772);
        expect(line.candidate.source).toBe('mutopia');
        expect(line.candidate.format).toBe('mid');
        expect(line.signals).toMatchObject({
            meter: true,
            fifths: true,
            catalogHit: true,
        });
        expect(line.score).toBeGreaterThanOrEqual(85);
        expect(line.band).toBe('accept');
        expect(line.reason).toBe('accept');
        expect(line.gitSha).toBe('deadbeef');
        const parsed = JSON.parse(formatDecisionLine(line)) as typeof line;
        expect(parsed.imslpPageTitle).toContain('BWV 772');
        expect(parsed.symbolicTier).toBe(1);
    });
});
