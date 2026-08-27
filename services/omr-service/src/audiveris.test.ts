import { describe, expect, it } from 'vitest';

import { buildAudiverisArgs, parseExtraOpts, PLAY_ALONG_AUDIVERIS_OPTIONS } from './audiveris.js';

describe('parseExtraOpts', () => {
    it('splits on whitespace and keeps quoted tokens', () => {
        expect(parseExtraOpts(undefined)).toEqual([]);
        expect(parseExtraOpts('  ')).toEqual([]);
        expect(parseExtraOpts('-sheets 1-2')).toEqual(['-sheets', '1-2']);
        expect(parseExtraOpts('-option "Book.Lyrics=false"')).toEqual(['-option', 'Book.Lyrics=false']);
    });
});

describe('buildAudiverisArgs', () => {
    it('includes play-along defaults and sheets range as one token', () => {
        const prev = process.env.AUDIVERIS_EXTRA_OPTS;
        delete process.env.AUDIVERIS_EXTRA_OPTS;
        try {
            expect(buildAudiverisArgs('/in.pdf', '/out', { sheets: { from: 2, to: 5 } })).toEqual([
                '-batch',
                '-export',
                '-output',
                '/out',
                ...PLAY_ALONG_AUDIVERIS_OPTIONS,
                '-sheets',
                '2-5',
                '--',
                '/in.pdf',
            ]);
            expect(buildAudiverisArgs('/in.pdf', '/out', { sheets: { from: 3, to: 3 } })).toContain('3');
        } finally {
            if (prev === undefined) {
                delete process.env.AUDIVERIS_EXTRA_OPTS;
            } else {
                process.env.AUDIVERIS_EXTRA_OPTS = prev;
            }
        }
    });

    it('appends AUDIVERIS_EXTRA_OPTS before call-site extras', () => {
        const prev = process.env.AUDIVERIS_EXTRA_OPTS;
        process.env.AUDIVERIS_EXTRA_OPTS = '-force';
        try {
            const args = buildAudiverisArgs('/in.pdf', '/out', { extraArgs: ['-transcribe'] });
            const forceAt = args.indexOf('-force');
            const transcribeAt = args.indexOf('-transcribe');
            expect(forceAt).toBeGreaterThan(-1);
            expect(transcribeAt).toBeGreaterThan(forceAt);
        } finally {
            if (prev === undefined) {
                delete process.env.AUDIVERIS_EXTRA_OPTS;
            } else {
                process.env.AUDIVERIS_EXTRA_OPTS = prev;
            }
        }
    });
});
