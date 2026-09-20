import { describe, expect, it, vi } from 'vitest';

import {
    editionListSummary,
    rankEditions,
    recommendEdition,
    recommendedBadge,
    urtextBadge,
    urtextConfidence,
} from '@/features/imslp/imslpDisplay';
import { canonicalImslpFilename } from '../../supabase/functions/_shared/imslpLicense';
import {
    fileBlockKey,
    fileMetaFor,
    NO_FILE_META,
    parseImslpFileBlocks,
} from '../../supabase/functions/_shared/imslpFileBlocks';
import {
    fetchWorkPageOrImages,
    IMSLP_WORK_IMAGES_ONLY,
    IMSLP_WORK_WITH_WIKITEXT,
    wikitextFromMwPage,
} from '../../supabase/functions/_shared/imslpWorkPage';

import { moonlightFilenames, moonlightWorkDetail } from './moonlightEditions';

describe('Moonlight ranking fixture', () => {
    const work = moonlightWorkDetail();
    const names = moonlightFilenames;

    it('does not default-select Weiner when Henle is restricted', () => {
        const ranked = rankEditions(work.editions);
        expect(ranked[0]?.filename).toBe(names.henleII);
        expect(ranked[1]?.filename).toBe(names.henleI);
        expect(ranked.map((e) => e.filename)).not.toContainEqual(undefined);
        expect(ranked.findIndex((e) => e.filename === names.weiner)).toBeGreaterThan(1);
        expect(recommendEdition(work.editions)).toBeNull();
        expect(recommendedBadge(ranked[0]!)).toBe('Urtext · Henle · 1976');
        expect(urtextBadge(ranked[0]!)).toBe('Urtext · Henle · 1976');
        expect(urtextBadge(ranked[1]!)).toBe('Urtext · Henle · 1976');
    });

    it('keeps the huge dump above the guitar arrangement', () => {
        const ranked = rankEditions(work.editions).map((e) => e.filename);
        expect(ranked.indexOf(names.dump)).toBeLessThan(ranked.indexOf(names.guitar));
        expect(ranked.indexOf(names.henleII)).toBeLessThan(ranked.indexOf(names.dump));
    });

    it('says Urtext first only because the tagged files actually lead', () => {
        expect(editionListSummary(work.editions)).toBe(
            `${work.editions.length} PDFs · Urtext first — scroll for others.`,
        );
        const noTag = work.editions.map((e) => ({ ...e, urtext: false }));
        expect(editionListSummary(noTag)).toBe(`${work.editions.length} PDFs — scroll for others.`);
    });

    it('gives publisher-only Henle a low-confidence house hint', () => {
        const henleI = work.editions.find((e) => e.filename === names.henleI)!;
        expect(henleI.filename.toLowerCase()).not.toContain('henle');
        expect(urtextConfidence({ ...henleI, urtext: false })).toBe('low');
    });
});

describe('imslp-work query contract', () => {
    it('requests images and revision wikitext together', () => {
        expect(IMSLP_WORK_WITH_WIKITEXT).toEqual(
            expect.objectContaining({
                action: 'query',
                prop: 'images|revisions',
                rvprop: 'content',
                imlimit: '500',
            }),
        );
        expect(IMSLP_WORK_IMAGES_ONLY.prop).toBe('images');
        expect(IMSLP_WORK_IMAGES_ONLY).not.toHaveProperty('rvprop');
    });

    it('parses revisions[0]["*"] and uses NO_FILE_META for unmatched titles', () => {
        const page = {
            revisions: [
                {
                    '*': '{{#fte:imslpfile|File Name 1=matched.pdf|Publisher Information={{P|G. Henle Verlag||Munich||1976||}} {{Urtext}}}}',
                },
            ],
        };
        const meta = parseImslpFileBlocks(wikitextFromMwPage(page));
        expect(fileMetaFor(meta, 'matched.pdf').urtext).toBe(true);
        expect(fileMetaFor(meta, 'unmatched-scan.pdf')).toEqual(NO_FILE_META);
        expect(wikitextFromMwPage({})).toBe('');
        expect(fileMetaFor(parseImslpFileBlocks(''), 'anything.pdf')).toEqual(NO_FILE_META);
    });

    it('falls back to images-only when the combined query times out', async () => {
        const imagesOnly = {
            query: { pages: { '1': { title: 'Moonlight', images: [{ title: 'File:a.pdf' }] } } },
        };
        const fetchMw = vi.fn().mockRejectedValueOnce(new Error('IMSLP API timeout')).mockResolvedValueOnce(imagesOnly);

        const result = await fetchWorkPageOrImages('Piano Sonata No.14', fetchMw);

        expect(fetchMw).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ prop: 'images|revisions', rvprop: 'content' }),
        );
        expect(fetchMw).toHaveBeenNthCalledWith(2, expect.objectContaining({ prop: 'images' }));
        expect(result).toBe(imagesOnly);
        expect(wikitextFromMwPage(imagesOnly.query.pages['1'] as { revisions?: Array<{ '*'?: string }> })).toBe('');
    });

    it('keeps fileBlockKey aligned with the license cache key', () => {
        const samples = ['pmlp01458-Op.27-2_Manuscript.pdf', '  moonlight   sonata.pdf  ', 'already Canonical.pdf'];
        for (const sample of samples) {
            expect(fileBlockKey(sample)).toBe(canonicalImslpFilename(sample));
        }
    });
});
