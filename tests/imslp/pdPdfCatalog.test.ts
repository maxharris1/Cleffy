import { describe, expect, it } from 'vitest';

import {
    catalogAttribution,
    catalogEditionsFromRows,
    catalogRowScore,
    catalogTitlesFromSeedJoin,
    isServableLicence,
    licenseClassFromTag,
    licenseLabelFromTag,
    matchStoreRow,
    mergeStoreRowsBySha,
    originLabel,
    pdObjectPath,
    safeObjectName,
    sortCatalogRows,
    uniquePdfShas,
    type PdPdfStoreRow,
} from '../../supabase/functions/_shared/pdPdfCatalog';

const row = (overrides: Partial<PdPdfStoreRow> = {}): PdPdfStoreRow => ({
    pdf_sha256: 'abc',
    filename: 'score.pdf',
    work_title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
    origin: 'mutopia',
    source_url: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1',
    licence_tag: 'PD',
    editor_credit: null,
    us_pd: true,
    byte_length: 442_963,
    page_count: 25,
    ...overrides,
});

describe('licence filter', () => {
    it('allows PD / CC0 / CC-BY / CC-BY-SA and nothing else', () => {
        expect(isServableLicence('PD')).toBe(true);
        expect(isServableLicence('CC0')).toBe(true);
        expect(isServableLicence('CC-BY')).toBe(true);
        expect(isServableLicence('CC-BY-SA')).toBe(true);
        expect(isServableLicence('CC-BY-NC')).toBe(false);
        expect(isServableLicence('non-pd')).toBe(false);
        expect(isServableLicence(null)).toBe(false);
    });

    it('maps tags onto the edition license class the work panel already understands', () => {
        expect(licenseClassFromTag('PD')).toBe('pd');
        expect(licenseClassFromTag('CC0')).toBe('pd');
        expect(licenseClassFromTag('CC-BY')).toBe('cc');
        expect(licenseClassFromTag('CC-BY-SA')).toBe('cc');
        expect(licenseLabelFromTag('PD')).toBe('Public domain');
        expect(licenseLabelFromTag('CC-BY-SA')).toBe('CC-BY-SA');
    });
});

describe('pd object path', () => {
    it('matches the seed script sanitizer so copy hits the stored object', () => {
        expect(safeObjectName('moonlight-let.pdf')).toBe('moonlight-let.pdf');
        expect(safeObjectName('Beethoven, L.v. - Piano Sonata 13.pdf')).toBe(
            'Beethoven_L.v._-_Piano_Sonata_13.pdf',
        );
        expect(pdObjectPath('deadbeef', 'moonlight-let.pdf')).toBe('deadbeef/moonlight-let.pdf');
    });
});

describe('catalog ranking', () => {
    it('prefers a Mutopia complete score over movement files and an IMSLP scan', () => {
        const rows = [
            row({ filename: 'promenade-1-let.pdf', origin: 'mutopia', pdf_sha256: 'p1', byte_length: 200_000 }),
            row({
                filename: 'pictures-at-an-exhibition-all-let.pdf',
                origin: 'mutopia',
                pdf_sha256: 'all',
                byte_length: 1_800_000,
            }),
            row({
                filename: 'PMLP-pictures.pdf',
                origin: 'imslp',
                pdf_sha256: 'scan',
                byte_length: 12_000_000,
            }),
        ];
        expect(sortCatalogRows(rows)[0]?.filename).toBe('pictures-at-an-exhibition-all-let.pdf');
        expect(catalogRowScore(rows[1]!, rows.length)).toBeGreaterThan(catalogRowScore(rows[0]!, rows.length));
    });

    it('drops non-servable rows when building editions', () => {
        const editions = catalogEditionsFromRows(
            [
                row({ licence_tag: 'CC-BY-NC', filename: 'nc.pdf' }),
                row({ filename: 'moonlight-let.pdf', licence_tag: 'CC-BY-SA', origin: 'mutopia' }),
            ],
            'https://imslp.org/wiki/Moonlight',
        );
        expect(editions).toHaveLength(1);
        expect(editions[0]?.source).toBe('catalog');
        expect(editions[0]?.pdfSha256).toBe('abc');
        expect(editions[0]?.license).toBe('cc');
        expect(editions[0]?.openUrl).toBe('https://imslp.org/wiki/Moonlight');
    });
});

describe('matchStoreRow', () => {
    const moonlight = row({
        pdf_sha256: 'sha-moon',
        filename: 'moonlight-let.pdf',
        licence_tag: 'CC-BY-SA',
        editor_credit: 'Stewart Holmes',
    });
    const scan = row({
        pdf_sha256: 'sha-scan',
        filename: 'PMLP01458.pdf',
        origin: 'imslp',
        licence_tag: 'PD',
    });

    it('matches an explicit sha before filename', () => {
        expect(matchStoreRow([moonlight, scan], { pdfSha256: 'sha-scan', filename: 'moonlight-let.pdf' })?.filename).toBe(
            'PMLP01458.pdf',
        );
    });

    it('matches work + filename, and falls back to the ranked row for that work', () => {
        expect(
            matchStoreRow([moonlight, scan], { filename: 'moonlight-let.pdf', workTitle: moonlight.work_title })
                ?.pdf_sha256,
        ).toBe('sha-moon');
        expect(matchStoreRow([moonlight, scan], { workTitle: moonlight.work_title })?.filename).toBe(
            'moonlight-let.pdf',
        );
    });

    it('never returns a non-servable row even when the sha matches', () => {
        expect(
            matchStoreRow([row({ pdf_sha256: 'bad', licence_tag: 'CC-BY-NC' })], { pdfSha256: 'bad' }),
        ).toBeNull();
    });

    it('matches a seed-join alias title whose store row kept a different work_title', () => {
        const stored = row({
            pdf_sha256: 'sha-clair',
            filename: 'debussy_Ste_Bergamesq_Clair-let.pdf',
            work_title: 'Suite bergamasque, CD 82 (Debussy, Claude)',
        });
        expect(matchStoreRow([stored], { workTitle: 'Clair de lune (Debussy, Claude)' })?.filename).toBe(
            'debussy_Ste_Bergamesq_Clair-let.pdf',
        );
    });
});

describe('seed-join catalog presence', () => {
    const furElise = 'Für Elise, WoO 59 (Beethoven, Ludwig van)';
    const bagatelle = 'Bagatelle in F minor (Beethoven, Ludwig van)';
    const clair = 'Clair de lune (Debussy, Claude)';
    const suite = 'Suite bergamasque, CD 82 (Debussy, Claude)';
    const shaElise = 'sha-elise';
    const shaClair = 'sha-clair';

    it('treats a fetched seed title as in-catalog when its sha is in the store, even if store.work_title differs', () => {
        expect(
            catalogTitlesFromSeedJoin(
                [furElise, bagatelle, clair],
                [
                    { work_title: furElise, pdf_sha256: shaElise },
                    { work_title: bagatelle, pdf_sha256: shaElise },
                    { work_title: clair, pdf_sha256: shaClair },
                    { work_title: suite, pdf_sha256: shaClair },
                ],
                [shaElise, shaClair],
            ).sort(),
        ).toEqual([bagatelle, clair, furElise].sort());
    });

    it('does not mark a fetched title whose sha never landed in the store', () => {
        expect(
            catalogTitlesFromSeedJoin(
                [furElise],
                [{ work_title: furElise, pdf_sha256: 'missing' }],
                [shaElise],
            ),
        ).toEqual([]);
    });

    it('merges store rows by sha so an alias title and the stored title share one PDF', () => {
        const stored = row({
            pdf_sha256: shaElise,
            filename: 'fur_Elise_WoO59-let.pdf',
            work_title: furElise,
        });
        const merged = mergeStoreRowsBySha([[], [stored]]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.filename).toBe('fur_Elise_WoO59-let.pdf');
        expect(uniquePdfShas([{ pdf_sha256: shaElise }, { pdf_sha256: shaElise }, { pdf_sha256: null }])).toEqual([
            shaElise,
        ]);
    });
});

describe('catalogAttribution', () => {
    it('names the editor and licence for CC-BY / CC-BY-SA, and stays silent for PD', () => {
        expect(
            catalogAttribution({
                license: 'cc',
                licenseLabel: 'CC-BY-SA',
                editorCredit: 'Stewart Holmes',
                origin: 'mutopia',
            }),
        ).toBe('Edition by Stewart Holmes (Mutopia) · CC-BY-SA');
        expect(catalogAttribution({ license: 'pd', origin: 'ia' })).toBeNull();
        expect(catalogAttribution({ license: 'cc', origin: 'mutopia' })).toBe(
            'Edition by Unnamed editor (Mutopia) · CC',
        );
        expect(originLabel('ia')).toBe('Internet Archive');
    });
});
