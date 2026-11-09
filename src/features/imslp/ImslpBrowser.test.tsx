import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImslpBrowserProps } from '@/features/imslp/ImslpBrowser';
import type { ImslpEdition, ImslpSearchResponse, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayWorkTitle,
    editionAvailability,
    editionFileLabel,
    editionHeadline,
    editionScopeTag,
    editionsNeedingFileLabel,
    friendlySearchError,
    genericScoreMessage,
    hasSearchableQuery,
    highlightRanges,
    isEditionImportable,
    isTaggedUrtext,
    rankEditions,
    recommendEdition,
    SEARCH_TIMEOUT_COPY,
    searchTokens,
    splitEditions,
    splitSearchResults,
    suggestedPdfName,
} from '@/features/imslp/imslpDisplay';
import { moonlightFilenames, moonlightWorkDetail } from '../../../tests/imslp/moonlightEditions';
import { groupPopularByComposer, POPULAR_WORKS, popularWorkTags } from '@/features/imslp/popularWorks';
import { buildSearchFilters, hasActiveFilters, labelsForCategories } from '@/features/imslp/searchFacets';

/**
 * Node defines a `localStorage` global whose getter returns undefined unless
 * the process was started with --localstorage-file, and under vitest's jsdom
 * environment `window` IS globalThis — so that getter shadows the Storage jsdom
 * built and `window.localStorage` reads as undefined.
 *
 * The panel survives that on its own (imslpPrefs treats a throwing store as
 * "nothing saved" and falls back to rows), but the card-view tests need a
 * store they can seed, so they bring their own.
 */
const memoryStorage = (): Storage => {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        key: (i: number) => [...entries.keys()][i] ?? null,
        getItem: (k: string) => entries.get(k) ?? null,
        setItem: (k: string, v: string) => void entries.set(k, String(v)),
        removeItem: (k: string) => void entries.delete(k),
        clear: () => entries.clear(),
    };
};

vi.stubGlobal('localStorage', memoryStorage());

const hit = (title: string, pageid: number) => ({
    title,
    pageid,
    snippet: '',
    composer: title.match(/\(([^)]+)\)\s*$/)?.[1] ?? null,
    imslpUrl: `https://imslp.org/wiki/${pageid}`,
});

const searchOk = (
    overrides: Partial<ImslpSearchResponse> & Pick<ImslpSearchResponse, 'results'>,
): ImslpSearchResponse => ({
    filterRelaxed: false,
    relaxed: [],
    total: overrides.results.length,
    hasMore: false,
    indexReady: true,
    period: null,
    mode: 'search',
    notReady: [],
    ...overrides,
});

const edition = (filename: string, overrides: Partial<ImslpEdition> = {}): ImslpEdition => ({
    filename,
    size: 1_800_000,
    mime: 'application/pdf',
    openUrl: `https://imslp.org/wiki/Special:ImagefromIndex/${filename}`,
    license: 'pd',
    licenseLabel: 'Public Domain',
    restriction: null,
    downloadable: true,
    ...overrides,
});

describe('imslp display helpers', () => {
    it.each([
        ['IMSLP is down', 'The source page is down'],
        ['Work not found on IMSLP', "We couldn't find this work. It may have been renamed or removed."],
        ['Work not found on the source page', "We couldn't find this work. It may have been renamed or removed."],
        ['IMSLP API timeout', 'The source page timed out'],
        ['IMSLP API HTTP 500', 'The source page returned HTTP 500'],
        ['IMSLP API answer too large', 'The source page response is too large'],
        ['Could not reach IMSLP to download this file.', 'Could not reach the source page to download this file.'],
        [
            "Cleffy couldn't reach IMSLP to check this edition's license, so it wasn't imported. Try again in a minute — or open it on IMSLP.",
            "Cleffy couldn't reach the source page to check this edition's license, so it wasn't imported. Try again in a minute.",
        ],
        [
            "Cleffy couldn't reach the source page to check this edition's license, so it wasn't imported. Try again in a minute — or view the source page.",
            "Cleffy couldn't reach the source page to check this edition's license, so it wasn't imported. Try again in a minute.",
        ],
        [
            'Too many IMSLP imports at once — waiting a moment before trying again',
            'Too many score imports at once — waiting a moment before trying again',
        ],
        [
            'IMSLP downloads are paced — queued for the next slot',
            'Score downloads are paced — queued for the next slot',
        ],
        ['IMSLP work lookup failed', 'Could not load the source page'],
        ['IMSLP search failed', 'Score search failed'],
        ['IMSLP download failed', 'Score download failed'],
        ['The source page did not return a PDF for this file.', 'The source page did not return a PDF for this file.'],
        ['Failed to fetch', 'Failed to fetch'],
    ])('renders older server prose naturally: %s', (raw, expected) => {
        expect(genericScoreMessage(raw)).toBe(expected);
    });

    it.each([
        new DOMException('The operation timed out.', 'TimeoutError'),
        new Error('canceling statement due to statement timeout'),
        new Error('Request timed out'),
        new Error('IMSLP took too long to answer.'),
        new Error('The source page took too long to answer.'),
        new Error(SEARCH_TIMEOUT_COPY),
    ])('uses the shared search timeout copy for %s', (error) => {
        expect(friendlySearchError(error)).toBe(SEARCH_TIMEOUT_COPY);
    });

    it('builds a safe suggested PDF name from the work title', () => {
        expect(suggestedPdfName('Piano Sonata No.14 (Beethoven, Ludwig van)', 'x.pdf')).toBe(
            'Piano Sonata No.14 (Beethoven, Ludwig van).pdf',
        );
        expect(suggestedPdfName('A/B:C?', 'file.pdf')).toBe('ABC.pdf');
    });

    it('splits IMSLP titles into work + composer', () => {
        expect(displayWorkTitle('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)')).toEqual({
            work: 'Piano Sonata No.14, Op.27 No.2',
            composer: 'Beethoven, Ludwig van',
        });
        expect(displayWorkTitle('Untitled')).toEqual({ work: 'Untitled', composer: null });
    });

    it('names an edition by publisher and year, never by its IMSLP file name', () => {
        expect(
            editionHeadline({ filename: 'WIMA.8c48-FESCo.pdf', publisher: 'Breitkopf und Härtel', year: 1870 }),
        ).toBe('Breitkopf und Härtel, 1870');
        expect(editionHeadline({ filename: 'Btsn312.pdf', publisher: ' G. Henle Verlag ' })).toBe('G. Henle Verlag');
        expect(editionHeadline({ filename: 'wier_ihml_1.pdf', year: 1880 })).toBe('Unknown publisher, 1880');
        expect(editionHeadline({ filename: 'joined_document.pdf', publisher: '  ' })).toBe('Unknown publisher');
        expect(editionFileLabel('PMLP01458-Beethoven_Moonlight.pdf')).toBe('Beethoven Moonlight');
        expect(editionFileLabel('.pdf')).toBe('.pdf');
    });

    it('tags only what is not the complete score', () => {
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Complete Score' })).toBeNull();
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Complete Score (filtered)' })).toBeNull();
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Score' })).toBeNull();
        expect(editionScopeTag({ filename: 'a.pdf' })).toBeNull();
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Parts' })).toBe('Parts');
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Movement 1' })).toBe('Movement 1');
        expect(editionScopeTag({ filename: 'a.pdf', description: 'Complete Score', arrangement: true })).toBe(
            'Arrangement',
        );
    });

    it('needs the file name only for editions that otherwise read the same', () => {
        const twins = editionsNeedingFileLabel([
            { filename: 'a.pdf', publisher: 'Peters', year: 1900, description: 'Complete Score' },
            { filename: 'b.pdf', publisher: 'Peters', year: 1900 },
            { filename: 'c.pdf', publisher: 'Peters', year: 1900, description: 'Parts' },
            { filename: 'd.pdf', publisher: 'Schott', year: 1900 },
        ]);
        expect([...twins].sort()).toEqual(['a.pdf', 'b.pdf']);
    });

    it('treats punctuation-only strings as not searchable', () => {
        expect(hasSearchableQuery('%%%')).toBe(false);
        expect(hasSearchableQuery('...')).toBe(false);
        expect(hasSearchableQuery('beethoven')).toBe(true);
        expect(friendlySearchError(new Error('canceling statement due to statement timeout'))).toBe(
            SEARCH_TIMEOUT_COPY,
        );
        expect(friendlySearchError(new Error('IMSLP is down'))).toBe('The source page is down');
    });

    it('recommends a mid-size edition over tiny or huge files', () => {
        const pick = recommendEdition([
            { filename: 'tiny.pdf', size: 12_000 },
            { filename: 'good-scan.pdf', size: 1_800_000 },
            { filename: 'huge-complete.pdf', size: 40_000_000 },
        ]);
        expect(pick?.filename).toBe('good-scan.pdf');
    });

    it('ranks a Urtext-house file first even when the filename says nothing about it', () => {
        const ranked = rankEditions([
            edition('schirmer-bulow.pdf', { publisher: 'Schirmer', year: 1895 }),
            edition('PMLP01458-E621557_247-260-beethoven--sonatas-vol1.pdf', {
                publisher: 'G. Henle Verlag',
                year: 1976,
                urtext: true,
                description: 'Complete Score',
                size: 30_000_000,
            }),
            edition('konemann.pdf', { publisher: 'Könemann', year: 1993, urtext: true, description: 'Complete Score' }),
            edition('plain-scan.pdf', { description: 'Complete Score' }),
        ]);
        expect(ranked.map((e) => e.filename)).toEqual([
            'PMLP01458-E621557_247-260-beethoven--sonatas-vol1.pdf',
            'konemann.pdf',
            'plain-scan.pdf',
            'schirmer-bulow.pdf',
        ]);
        expect(isTaggedUrtext(ranked[0]!)).toBe(true);
        expect(isTaggedUrtext(ranked[1]!)).toBe(true);
        // Filename-only hints never claim the Urtext badge.
        expect(isTaggedUrtext(edition('henle-urtext-scan.pdf'))).toBe(false);
    });

    it('no longer prefers Schirmer, Breitkopf, typeset or edited filenames', () => {
        const ranked = rankEditions([
            edition('beethoven-schirmer-edited.pdf', { size: 2_000_000 }),
            edition('beethoven-breitkopf-typeset.pdf', { size: 2_000_000 }),
            edition('beethoven-plain.pdf', { size: 2_000_000 }),
        ]);
        // Equal size, no Urtext signal: IMSLP's own order stands.
        expect(ranked.map((e) => e.filename)).toEqual([
            'beethoven-schirmer-edited.pdf',
            'beethoven-breitkopf-typeset.pdf',
            'beethoven-plain.pdf',
        ]);
    });

    it('does not read bare "wiener" as Wiener Urtext, and demotes arrangements', () => {
        const ranked = rankEditions([
            edition('beethoven.moonlight.wiener.pdf', {
                publisher: 'Editio Musica Budapest',
                year: 1959,
                description: 'Complete Score',
            }),
            edition('moonlight-arr-cello.pdf', { description: 'Complete Score (arr. cello)' }),
            edition('sonata-no14.pdf', { description: 'Complete Score' }),
        ]);
        expect(ranked.map((e) => e.filename)).toEqual([
            'beethoven.moonlight.wiener.pdf',
            'sonata-no14.pdf',
            'moonlight-arr-cello.pdf',
        ]);
        expect(isTaggedUrtext(ranked[0]!)).toBe(false);
        expect(recommendEdition(ranked)?.filename).toBe('beethoven.moonlight.wiener.pdf');
    });

    it('pre-selects Weiner when the only Urtext is restricted — Add works on the first screen', () => {
        const pick = recommendEdition([
            edition('PMLP01458-beethoven_piano-sonata-op27-no2_henle-pp17-30.pdf', {
                publisher: 'G. Henle Verlag',
                year: 1976,
                urtext: true,
                description: 'Complete Score',
                downloadable: false,
                restriction: 'See notes on copyright status for urtext editions',
            }),
            edition('beethoven.moonlight.wiener.pdf', {
                publisher: 'Editio Musica Budapest',
                year: 1959,
                description: 'Complete Score',
            }),
        ]);
        expect(pick?.filename).toBe('beethoven.moonlight.wiener.pdf');
    });

    it('demotes a file whose IMSLP block names an arranger even when it is a "Complete Score"', () => {
        const ranked = rankEditions([
            edition('lopez-villanueva-trio.pdf', { description: 'Complete Score', arrangement: true, size: 2_000_000 }),
            edition('huge-original-dump.pdf', { description: 'Complete Score', size: 40_000_000 }),
            edition('original-scan.pdf', { description: 'Complete Score', size: 3_000_000 }),
        ]);
        expect(ranked.map((e) => e.filename)).toEqual([
            'original-scan.pdf',
            'huge-original-dump.pdf',
            'lopez-villanueva-trio.pdf',
        ]);
    });

    it('gives Complete Score parentheticals the same complete bonus', () => {
        const ranked = rankEditions([
            edition('piano-original.pdf', { description: 'Complete Score (piano)', size: 2_000_000 }),
            edition('clean-typeset.pdf', { description: 'Complete Score', size: 2_000_000 }),
        ]);
        expect(ranked.map((e) => e.filename)).toEqual(['piano-original.pdf', 'clean-typeset.pdf']);
    });

    it('lists importable rows first, then what it cannot fetch: Urtext, license-unknown, restricted', () => {
        const ranked = rankEditions([
            edition('restricted-henle.pdf', {
                downloadable: false,
                restriction: 'See notes on copyright status for urtext editions',
                publisher: 'G. Henle Verlag',
                urtext: true,
            }),
            edition('mystery.pdf', { license: 'unknown', licenseLabel: null }),
            edition('plain-scan.pdf'),
            edition('restricted-peters.pdf', { downloadable: false, restriction: 'Non-PD US' }),
        ]);
        expect(ranked.map((e) => e.filename)).toEqual([
            'plain-scan.pdf',
            'restricted-henle.pdf',
            'mystery.pdf',
            'restricted-peters.pdf',
        ]);
        expect(recommendEdition(ranked)?.filename).toBe('plain-scan.pdf');
        const { importable, unavailable } = splitEditions(ranked);
        expect(importable.map((e) => e.filename)).toEqual(['plain-scan.pdf']);
        expect(unavailable.map((e) => e.filename)).toEqual([
            'restricted-henle.pdf',
            'mystery.pdf',
            'restricted-peters.pdf',
        ]);
    });

    it('never recommends a restricted Urtext or a license-unknown edition', () => {
        expect(
            recommendEdition([
                edition('henle-urtext.pdf', {
                    downloadable: false,
                    license: 'pd',
                    restriction: 'Non-PD US',
                    publisher: 'G. Henle Verlag',
                    urtext: true,
                }),
                edition('mystery.pdf', { license: 'unknown' }),
                edition('plain-scan.pdf', { size: 900_000 }),
            ])?.filename,
        ).toBe('plain-scan.pdf');
        expect(isEditionImportable(edition('mystery.pdf', { license: 'unknown' }))).toBe(false);
        expect(
            recommendEdition([
                edition('mystery.pdf', { license: 'unknown' }),
                edition('plain-scan.pdf', { size: 900_000 }),
            ])?.filename,
        ).toBe('plain-scan.pdf');
    });

    it('returns null when nothing is downloadable — no auto-selection', () => {
        expect(
            recommendEdition([
                edition('a.pdf', { downloadable: false, restriction: 'Non-PD US' }),
                edition('b.pdf', { downloadable: false, restriction: 'Non-PD EU' }),
            ]),
        ).toBeNull();
    });

    it('describes edition availability for the row badges', () => {
        expect(editionAvailability(edition('a.pdf'))).toEqual({ kind: 'downloadable', label: 'Public domain' });
        expect(editionAvailability(edition('b.pdf', { downloadable: false, restriction: 'Non-PD US' }))).toEqual({
            kind: 'restricted',
            label: 'Non-PD US',
        });
        expect(editionAvailability(edition('c.pdf', { license: 'unknown', licenseLabel: null }))).toEqual({
            kind: 'unknown',
            label: 'License unknown',
        });
        // Pre-license data (older responses, plain fixtures) shows nothing.
        expect(editionAvailability({ filename: 'd.pdf', size: null } as ImslpEdition)).toBeNull();
        expect(
            editionAvailability(
                edition('e.pdf', {
                    license: 'unknown',
                    licenseLabel: null,
                    downloadable: false,
                    licenseCheck: 'unavailable',
                }),
            ),
        ).toEqual({ kind: 'unknown', label: 'License check unavailable' });
        expect(
            isEditionImportable(
                edition('e.pdf', {
                    license: 'unknown',
                    licenseLabel: null,
                    downloadable: false,
                    licenseCheck: 'unavailable',
                }),
            ),
        ).toBe(false);
    });

    it('splits search results into best + more', () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        expect(splitSearchResults(items)).toEqual({
            best: [0, 1, 2, 3, 4, 5, 6, 7],
            more: [8, 9, 10, 11],
        });
        expect(splitSearchResults([1, 2, 3])).toEqual({ best: [1, 2, 3], more: [] });
    });

    it('tokenizes search queries', () => {
        expect(searchTokens('Beethoven moonlight')).toEqual(['Beethoven', 'moonlight']);
        expect(searchTokens('K. 331')).toEqual(['K', '331']);
        expect(searchTokens('Op. 27 No. 2')).toEqual(['Op', '27', 'No', '2']);
        expect(searchTokens('d\'Indy "Clair" de lune, DE !!!')).toEqual(["d'Indy", 'Clair', 'de', 'lune']);
    });

    const marked = (text: string, query: string): string[] =>
        highlightRanges(text, searchTokens(query)).map(({ start, end }) => text.slice(start, end));

    it('highlights short query words only as whole words', () => {
        // The QA repro: "de" lit up inside Debussy, Claude and Préludes.
        expect(marked('Debussy, Claude', 'Clair de lune')).toEqual([]);
        expect(marked('Préludes, Livre 2', 'Clair de lune')).toEqual([]);
        expect(marked('Suite bergamasque — Clair de lune', 'Clair de lune')).toEqual(['Clair', 'de', 'lune']);
        expect(marked('Au Clair de la Lune, Op.41', 'clair de lune')).toEqual(['Clair', 'de', 'Lune']);
        // Catalogue numbers match whole: K.331 is not K.3310, and "2" is not the "2" of "27".
        expect(marked('Piano Sonata No.14, Op.27 No.2', 'Op. 27 No. 2')).toEqual(['No', 'Op', '27', 'No', '2']);
        expect(marked('Piano Sonata No.11, K.331/300i', 'K. 331')).toEqual(['K', '331']);
        expect(marked('Sonata, K.3310', 'K 331')).toEqual(['K']);
        // Touching matches merge into one mark.
        expect(marked('Sonata BWV846a', 'bwv 846')).toEqual(['BWV846']);
    });

    it('highlights longer words from a word start, accent- and case-folded', () => {
        expect(marked('Sonata (Beethoven, Ludwig van)', 'beeth')).toEqual(['Beeth']);
        expect(marked('Gymnopédies (Satie, Erik)', 'gymnopedie')).toEqual(['Gymnopédie']);
        // A decomposed accent stays inside the mark with its letter.
        expect(marked('Gymnopédie', 'gymnopedie')).toEqual(['Gymnopédie']);
        expect(marked('Rhapsody (Gershwin)', 'sody')).toEqual([]);
        expect(marked('Anything', '')).toEqual([]);
    });
});

describe('popular works browse', () => {
    it('includes familiar starter pieces', () => {
        expect(POPULAR_WORKS.some((w) => w.label === 'Moonlight Sonata')).toBe(true);
        expect(POPULAR_WORKS.length).toBeGreaterThanOrEqual(100);
    });

    it('groups works by composer with expanded lists', () => {
        const groups = groupPopularByComposer();
        expect(groups.length).toBeGreaterThan(5);
        const beethoven = groups.find((g) => g.composer === 'Beethoven');
        expect(beethoven?.works.some((w) => w.label === 'Moonlight Sonata')).toBe(true);
        expect(beethoven?.works.length).toBeGreaterThanOrEqual(8);
    });

    it('humanizes a curated work’s facet ids into card tags', () => {
        const moonlight = POPULAR_WORKS.find((w) => w.label === 'Moonlight Sonata');
        expect(moonlight && popularWorkTags(moonlight)).toEqual(['Piano', 'Sonata', 'Classical', 'C-sharp minor']);
        // Only fields the work really has — no fabricated tags.
        expect(popularWorkTags({ label: 'X', title: 'X (Y, Z)', composer: 'Y' })).toEqual([]);
    });
});

describe('search facets', () => {
    it('builds filters from selected facet ids', () => {
        const filters = buildSearchFilters({
            composerIds: ['beethoven'],
            instrumentIds: ['piano'],
            formIds: ['sonata'],
        });
        expect(filters.composerCategories).toEqual(['Beethoven, Ludwig van']);
        expect(filters.instruments).toEqual(['piano']);
        expect(filters.forms).toEqual(['sonata']);
        expect(hasActiveFilters(filters)).toBe(true);
        expect(filters).toEqual(
            expect.objectContaining({
                composerCategory: 'Beethoven, Ludwig van',
                instrument: 'piano',
                form: 'sonata',
            }),
        );
    });
});

describe('ImslpBrowser', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');
    });

    afterEach(async () => {
        const { cleanup } = await import('@testing-library/react');
        cleanup();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    const renderBrowser = async (props: Partial<ImslpBrowserProps> = {}, initialEntry = '/search') => {
        const { render } = await import('@testing-library/react');
        const { ImslpBrowser } = await import('@/features/imslp/ImslpBrowser');
        return render(
            <MemoryRouter initialEntries={[initialEntry]}>
                <ImslpBrowser onImportFile={vi.fn()} onImportImslp={vi.fn()} {...props} />
            </MemoryRouter>,
        );
    };

    it('starts piano-scoped with the curated list and no network call', async () => {
        const { screen } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');
        const searchSpy = vi.spyOn(api, 'searchImslp');

        await renderBrowser();

        expect(screen.getByRole('heading', { name: 'Popular' })).toBeInTheDocument();
        expect(screen.getAllByText('Public-domain scores via IMSLP')).toHaveLength(1);
        expect(screen.getByText('Moonlight Sonata')).toBeInTheDocument();
        // Piano default: pre-pressed chip, piano-only curated list, status says so.
        const instrumentTab = screen.getByRole('button', { name: 'Instrument' });
        instrumentTab.click();
        expect(await screen.findByRole('button', { name: 'Piano' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByText('Swan Lake')).not.toBeInTheDocument();
        expect(screen.getByText(/Piano · Popular ·/)).toBeInTheDocument();
        // No fake ARIA widgets remain.
        expect(screen.queryByRole('tab')).not.toBeInTheDocument();
        expect(screen.queryByRole('option')).not.toBeInTheDocument();
        // The default state must not fan out to IMSLP.
        await new Promise((r) => setTimeout(r, 350));
        expect(searchSpy).not.toHaveBeenCalled();
    });

    it('runs a debounced search with the piano filter and groups best matches', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: Array.from({ length: 10 }, (_, i) =>
                    hit(
                        i === 0
                            ? 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)'
                            : `Other Work ${i} (Composer, Name)`,
                        1458 + i,
                    ),
                ),
            }),
        );

        await renderBrowser();
        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'beethoven sonata',
        );

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        const lastCall = searchSpy.mock.calls.at(-1);
        expect(lastCall?.[1]).toEqual(
            expect.objectContaining({ filters: expect.objectContaining({ instruments: ['piano'] }) }),
        );
        expect(await screen.findByText('Best matches')).toBeInTheDocument();
        expect(screen.getByText('More scores')).toBeInTheDocument();
        expect(screen.getByText((_, el) => el?.textContent === 'Piano Sonata No.14, Op.27 No.2')).toBeInTheDocument();
    });

    it('says it is searching — never "unavailable" — while the debounce is still armed', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockImplementation(() => new Promise(() => {}));

        await renderBrowser();
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'be');

        // Still inside the 280 ms debounce: nothing has failed, so the
        // aria-live status must not announce a failure.
        expect(searchSpy).not.toHaveBeenCalled();
        expect(screen.getByText('Piano · Searching scores…')).toBeInTheDocument();
        expect(screen.queryByText(/Search unavailable/)).not.toBeInTheDocument();
    });

    it('says Searching — not unavailable — while debounce is armed after a failed search', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockRejectedValueOnce(new Error('IMSLP is down'))
            .mockImplementation(() => new Promise(() => {}));

        await renderBrowser();
        const input = screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…');
        await userEvent.type(input, 'be');
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(1);
        });
        expect(await screen.findByText('Piano · Search unavailable')).toBeInTheDocument();

        await userEvent.type(input, 'ethoven');
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Piano · Searching scores…')).toBeInTheDocument();
        expect(screen.queryByText(/Search unavailable/)).not.toBeInTheDocument();
    });

    it('names the selected instrument in the relaxed-filter hint', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Violin Sonata No.9, Op.47 (Beethoven, Ludwig van)', 47)],
                filterRelaxed: true,
                relaxed: ['instrument'],
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Piano' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Violin' }));
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'sonata');

        expect(await screen.findByText(/the violin filter matched too few scores/)).toBeInTheDocument();
        expect(screen.queryByText(/piano filter/)).not.toBeInTheDocument();
    });

    it('shows sort chips for an era browse now that the index can sort', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Toccata and Fugue in D minor (Bach, Johann Sebastian)', 565)],
                mode: 'browse',
                total: 1,
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Piano' }));
        await userEvent.click(screen.getByRole('button', { name: 'Era' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Baroque' }));

        expect(await screen.findByText('Best matches')).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Sort results' })).toBeInTheDocument();
    });

    it('keeps prior results and shows an error — not the empty state — when a search fails', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockResolvedValueOnce(searchOk({ results: [hit('Nocturnes, Op.9 (Chopin, Frédéric)', 7)] }))
            .mockRejectedValueOnce(new Error('IMSLP is down'));

        await renderBrowser();
        const input = screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…');
        await userEvent.type(input, 'chopin');
        await screen.findByText('Best matches');

        await userEvent.type(input, ' nocturne');
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(2);
        });

        expect(await screen.findByText('The source page is down')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        // Prior results stay; the "No matches" empty state must not appear.
        expect(screen.getByText('Best matches')).toBeInTheDocument();
        expect(screen.queryByText('No matches')).not.toBeInTheDocument();
    });

    it('shows friendly copy instead of a Postgres statement timeout', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockRejectedValue(new Error('canceling statement due to statement timeout'));

        await renderBrowser();
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'chopin');

        expect(await screen.findByText(SEARCH_TIMEOUT_COPY)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByText(/canceling statement/)).not.toBeInTheDocument();
    });

    it('treats a punctuation-only query as no matches, not a piano browse', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');
        const searchSpy = vi.spyOn(api, 'searchImslp');

        await renderBrowser();
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), '%%%');

        expect(await screen.findByText('No matches')).toBeInTheDocument();
        expect(searchSpy).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Popular' })).not.toBeInTheDocument();
    });

    it('ignores a stale response that resolves after a newer one', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        let releaseFirst: (() => void) | undefined;
        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseFirst = () => resolve(searchOk({ results: [hit('Stale Result (Old, Query)', 1)] }));
                    }),
            )
            .mockResolvedValueOnce(searchOk({ results: [hit('Fresh Result (New, Query)', 2)] }));

        await renderBrowser();
        const input = screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…');
        await userEvent.type(input, 'chopin');
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(1);
        });
        await userEvent.type(input, ' ballade');
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(2);
        });
        await screen.findByText('Fresh Result');

        releaseFirst?.();
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText('Stale Result')).not.toBeInTheDocument();
        expect(screen.getByText('Fresh Result')).toBeInTheDocument();
    });

    /** The work view is open once its Back is (the search view has none). */
    const waitForWork = async () => {
        const { screen } = await import('@testing-library/react');
        return screen.findByRole('button', { name: 'Back' });
    };

    /** The full list is one click away; open it. */
    const openEditionList = async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        await userEvent.click(screen.getByRole('button', { name: /^Choose a different edition/ }));
        return screen.getByRole('list', { name: 'PDF editions' });
    };

    /** The card above the toggle: the edition Add will import. */
    const editionCard = async () => {
        const { screen } = await import('@testing-library/react');
        return screen.getByRole('button', { name: /^Choose a different edition/ }).closest('.rounded-xl')!
            .firstElementChild as HTMLElement;
    };

    it('opens Moonlight on one recommended edition and Add, with every other choice one click away', async () => {
        // Henle used to lead the list with nothing selected and Add disabled:
        // the first screen of every popular work was greyed-out rows.
        const { screen, waitFor, within } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work = moonlightWorkDetail();
        const names = moonlightFilenames;
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();
        const downloadable = work.editions.length - 2;

        // The piece title leads, with Back beside it in the panel — only one Back.
        const panel = screen.getByRole('heading', { level: 2, name: 'Piano Sonata No.14, Op.27 No.2' });
        expect(panel.closest('.imslp-panel-view')).not.toBeNull();
        expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
        expect(
            screen.getAllByText('Public-domain scores via IMSLP').filter((line) => !line.closest('[hidden]')),
        ).toHaveLength(1);

        // One card: the recommended edition by publisher and year, then Add.
        const card = within(await editionCard());
        expect(card.getByText('Schirmer, 1895')).toBeInTheDocument();
        expect(card.getByText('Recommended')).toBeInTheDocument();
        const add = screen.getByRole('button', { name: 'Add to my library' });
        expect(add).toBeEnabled();
        expect(screen.queryByText('Select a downloadable edition to add.')).not.toBeInTheDocument();

        // Nothing else by default: no radios, no restricted section, one source link,
        // no sizes, licenses or "Complete Score".
        expect(screen.queryByRole('radio')).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.queryByText(/Not downloadable here/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Henle/)).not.toBeInTheDocument();
        expect(screen.getAllByRole('link', { name: 'View source page' })).toHaveLength(1);
        expect(screen.queryByText(/\d (KB|MB)\b/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Public domain$/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Complete Score/)).not.toBeInTheDocument();
        expect(onImportImslp).not.toHaveBeenCalled();

        const toggle = screen.getByRole('button', { name: `Choose a different edition (${downloadable - 1})` });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const list = await openEditionList();
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(downloadable);
        expect(within(rows[0]!).getByRole('radio')).toBeChecked();
        expect(rows[0]).toHaveTextContent('Schirmer, 1895');
        // The restricted Henle files stay out of the list: one muted line points to the source.
        expect(within(list).queryByText(/Henle/)).not.toBeInTheDocument();
        const restrictedLine = screen.getByText(/2 more editions can’t be downloaded here\./);
        expect(within(restrictedLine).getByRole('link', { name: 'View source page' })).toHaveAttribute(
            'href',
            work.imslpUrl,
        );

        const weinerRadio = screen.getByRole('radio', { name: /Editio Musica Budapest, 1959/ });
        expect(weinerRadio).not.toBeChecked();
        await userEvent.click(weinerRadio);
        expect(weinerRadio).toBeChecked();
        // The card follows the choice; the same Add imports it.
        const chosen = within(await editionCard());
        expect(chosen.getByText('Editio Musica Budapest, 1959')).toBeInTheDocument();
        expect(chosen.queryByText('Recommended')).not.toBeInTheDocument();
        expect(add).toBeEnabled();
        await userEvent.click(add);
        await waitFor(() => {
            expect(onImportImslp).toHaveBeenCalledTimes(1);
        });
        expect(onImportImslp).toHaveBeenCalledWith(
            names.weiner,
            work.title,
            true,
            expect.any(Function),
            expect.any(AbortSignal),
        );
    });

    it('opens a work from ?work=, ranks downloadable Urtext first, and imports the selection', async () => {
        const { screen, waitFor, within } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            imslpUrl: 'https://imslp.org/wiki/Moonlight',
            editions: [
                edition('restricted-peters.pdf', { downloadable: false, restriction: 'Non-PD US' }),
                edition('schirmer-bulow.pdf', { publisher: 'Schirmer', year: 1895, description: 'Complete Score' }),
                edition('clean-scan.pdf', { description: 'Complete Score' }),
                edition('PMLP01458-beethoven_sonatas-vol1.pdf', {
                    publisher: 'G. Henle Verlag',
                    year: 1976,
                    urtext: true,
                    description: 'Complete Score',
                }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        const card = within(await editionCard());
        expect(card.getByText('G. Henle Verlag, 1976')).toBeInTheDocument();
        expect(card.getByText('Urtext')).toBeInTheDocument();
        expect(card.getByText('Recommended')).toBeInTheDocument();
        // A complete score needs no tag, and the file name adds nothing here.
        expect(screen.queryByText(/Complete Score/)).not.toBeInTheDocument();
        expect(screen.queryByText(/beethoven sonatas-vol1/)).not.toBeInTheDocument();

        const list = await openEditionList();
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(3);
        const henleRadio = within(rows[0]!).getByRole('radio');
        expect(henleRadio).toBeChecked();
        expect(within(list).queryByText(/peters/)).not.toBeInTheDocument();
        expect(screen.getByText(/1 more edition can’t be downloaded here\./)).toBeInTheDocument();
        expect(onImportImslp).not.toHaveBeenCalled();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

        await userEvent.click(within(rows[2]!).getByRole('radio'));
        expect(within(rows[2]!).getByRole('radio')).toBeChecked();
        expect(henleRadio).not.toBeChecked();
        await userEvent.click(screen.getByRole('button', { name: 'Add to my library' }));
        await waitFor(() => {
            expect(onImportImslp).toHaveBeenCalledWith(
                'clean-scan.pdf',
                work.title,
                true,
                expect.any(Function),
                expect.any(AbortSignal),
            );
        });
        expect(onImportImslp).toHaveBeenCalledTimes(1);
    });

    it('marks the recommendation without an Urtext badge when nothing is tagged', async () => {
        const { screen, within } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [
                edition('tiny.pdf', { size: 12_000 }),
                edition('clean-scan.pdf'),
                edition('other-scan.pdf'),
                edition('another-scan.pdf'),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        // Four publisher-less scans: the file name is the only thing telling them apart.
        const card = within(await editionCard());
        expect(card.getByText('Unknown publisher')).toBeInTheDocument();
        expect(card.getByText('clean-scan')).toBeInTheDocument();
        expect(card.getByText('Recommended')).toBeInTheDocument();
        expect(screen.queryByText('Urtext')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add to my library' })).toBeEnabled();

        const list = await openEditionList();
        const recommendedRow = within(list).getByText('Recommended').closest('li');
        expect(recommendedRow).toHaveTextContent('clean-scan');
        expect(within(recommendedRow!).getByRole('radio')).toBeChecked();
    });

    it('freezes the rows while a download is in flight and ignores a second click in the same tick', async () => {
        const { screen, within, fireEvent } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('a.pdf'), edition('b.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockImplementation(() => new Promise(() => {}));

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        const list = await openEditionList();
        const radios = within(list).getAllByRole('radio');
        expect(radios).toHaveLength(2);
        expect(radios[0]).toBeChecked();
        fireEvent.click(radios[1]!);
        expect(radios[1]).toBeChecked();

        const add = screen.getByRole('button', { name: 'Add to my library' });
        fireEvent.click(add);
        fireEvent.click(add);
        fireEvent.click(within(list).getAllByRole('radio')[0]!);

        expect(await screen.findByRole('button', { name: 'Downloading score…' })).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('Downloading score…');
        for (const radio of within(list).getAllByRole('radio')) {
            expect(radio).toBeDisabled();
        }
        expect(onImportImslp).toHaveBeenCalledTimes(1);
        expect(onImportImslp).toHaveBeenCalledWith(
            'b.pdf',
            work.title,
            true,
            expect.any(Function),
            expect.any(AbortSignal),
        );
        expect(within(list).queryByRole('link')).not.toBeInTheDocument();
        expect(screen.getAllByRole('link', { name: 'View source page' })).toHaveLength(1);
    });

    it('shows a paced download as queued, then downloading, while the client retries on its own', async () => {
        const { screen, act } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('a.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        let report: ((stage: 'queued' | 'downloading') => void) | undefined;
        let finish: (() => void) | undefined;
        const onImportImslp = vi.fn().mockImplementation(
            (_f: string, _t: string, _a: boolean, onStage: (stage: 'queued' | 'downloading') => void) =>
                new Promise((resolve) => {
                    report = onStage;
                    finish = () => resolve({ ok: true });
                }),
        );

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();
        await userEvent.click(screen.getByRole('button', { name: 'Add to my library' }));
        expect(await screen.findByRole('button', { name: 'Downloading score…' })).toBeDisabled();

        act(() => report?.('queued'));
        // Honest progress, not an error: the Add button stays locked and says why.
        expect(screen.getByRole('button', { name: 'Queued for download…' })).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('Queued — score downloads are paced');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        act(() => report?.('downloading'));
        expect(screen.getByRole('button', { name: 'Downloading score…' })).toBeDisabled();

        await act(async () => finish?.());
        expect(await screen.findByRole('button', { name: 'Add to my library' })).toBeEnabled();
        expect(onImportImslp).toHaveBeenCalledTimes(1);
    });

    it('cancels a queued import from the panel, back to an idle Add with no error', async () => {
        const { screen, act } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('a.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        let signal: AbortSignal | undefined;
        let report: ((stage: 'queued' | 'downloading') => void) | undefined;
        const onImportImslp = vi.fn().mockImplementation(
            (
                _f: string,
                _t: string,
                _a: boolean,
                onStage: (stage: 'queued' | 'downloading') => void,
                abort: AbortSignal,
            ) =>
                new Promise((_resolve, reject) => {
                    report = onStage;
                    signal = abort;
                    // What imslpApi does when a queued wait is cancelled.
                    abort.addEventListener('abort', () => reject(new api.ImslpImportCancelledError()));
                }),
        );

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();
        await userEvent.click(screen.getByRole('button', { name: 'Add to my library' }));
        // No cancel while a request is out: the function would finish regardless.
        expect(screen.queryByRole('button', { name: 'Cancel import' })).not.toBeInTheDocument();

        act(() => report?.('queued'));
        await userEvent.click(screen.getByRole('button', { name: 'Cancel import' }));

        expect(signal?.aborted).toBe(true);
        expect(await screen.findByRole('button', { name: 'Add to my library' })).toBeEnabled();
        expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('cancels a queued import when the panel unmounts', async () => {
        const { screen, act } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('a.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        let signal: AbortSignal | undefined;
        const onImportImslp = vi
            .fn()
            .mockImplementation(
                (_f: string, _t: string, _a: boolean, onStage: (stage: 'queued') => void, abort: AbortSignal) => {
                    signal = abort;
                    onStage('queued');
                    return new Promise(() => undefined);
                },
            );

        const { unmount } = await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();
        await userEvent.click(screen.getByRole('button', { name: 'Add to my library' }));
        expect(signal?.aborted).toBe(false);

        act(() => unmount());
        expect(signal?.aborted).toBe(true);
    });

    it('sends the user to the source page when the license lookup itself was unavailable', async () => {
        const { screen } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [
                edition('unchecked.pdf', {
                    license: 'unknown',
                    licenseLabel: null,
                    downloadable: false,
                    licenseCheck: 'unavailable',
                }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await screen.findByText(/Couldn’t check the licenses just now/);

        expect(screen.queryByRole('list', { name: 'PDF editions' })).not.toBeInTheDocument();
        expect(screen.queryByRole('radio')).not.toBeInTheDocument();
        expect(screen.queryByText('unchecked')).not.toBeInTheDocument();
        for (const link of screen.getAllByRole('link', { name: 'View source page' })) {
            expect(link).toHaveAttribute('href', work.imslpUrl);
        }
        expect(screen.queryByRole('button', { name: 'Add to my library' })).not.toBeInTheDocument();
    });

    it('does not turn a license-unknown row into a one-tap download', async () => {
        const { screen, within } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [
                edition('known.pdf', { publisher: 'Peters', description: 'Complete Score' }),
                edition('mystery.pdf', { license: 'unknown', licenseLabel: null, description: 'Complete Score' }),
                edition('also-known.pdf', { publisher: 'Schott', description: 'Complete Score' }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        const list = await openEditionList();
        const radios = within(list).getAllByRole('radio');
        expect(radios).toHaveLength(2);
        expect(within(list).getByRole('radio', { name: /Peters/ })).toBeChecked();
        expect(screen.queryByText('mystery')).not.toBeInTheDocument();
        expect(screen.getByText(/1 more edition can’t be downloaded here\./)).toBeInTheDocument();
        expect(onImportImslp).not.toHaveBeenCalled();
    });

    it('shows the guidance state when every edition is restricted', async () => {
        const { screen } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Second Rhapsody (Gershwin, George)',
            composer: 'Gershwin, George',
            imslpUrl: 'https://imslp.org/wiki/SecondRhapsody',
            editions: [
                edition('eu-only.pdf', { downloadable: false, restriction: 'Non-PD US' }),
                edition('eu-only-2.pdf', { downloadable: false, restriction: 'Non-PD US' }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);

        await screen.findByText(/None of these editions can be imported automatically/);
        // No per-file restricted cards: the work's source page is the way on.
        expect(screen.queryByText(/eu-only/)).not.toBeInTheDocument();
        expect(screen.queryByText('Non-PD US')).not.toBeInTheDocument();
        for (const link of screen.getAllByRole('link', { name: 'View source page' })) {
            expect(link).toHaveAttribute('href', work.imslpUrl);
        }
        expect(screen.getByText('Choose downloaded PDF')).toBeInTheDocument();
        // No import button, no consent checkbox — there is nothing to import.
        expect(screen.queryByRole('button', { name: 'Add to my library' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Choose a different edition/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('imports the pre-selected recommended edition from Add without a disclaimer checkbox', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('tiny.pdf', { size: 12_000 }), edition('clean-scan.pdf'), edition('other-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        expect(await editionCard()).toHaveTextContent('clean-scan');
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Add to my library' }));
        await waitFor(() => {
            expect(onImportImslp).toHaveBeenCalledWith(
                'clean-scan.pdf',
                work.title,
                true,
                expect.any(Function),
                expect.any(AbortSignal),
            );
        });
    });

    it('disables Add with a reason when cloud-score quota is exhausted', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('clean-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp, quotaExhausted: true }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        const add = screen.getByRole('button', { name: 'Add to my library' });
        expect(add).toBeDisabled();
        expect(screen.getByText(/Cloud-score limit reached/)).toBeInTheDocument();
        await userEvent.click(add);
        expect(onImportImslp).not.toHaveBeenCalled();
    });

    it('links the disabled Add to the plans', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('clean-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onUpgrade = vi.fn();

        await renderBrowser({ quotaExhausted: true, onUpgrade }, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        await userEvent.click(screen.getByRole('button', { name: 'upgrade to add this edition' }));
        expect(onUpgrade).toHaveBeenCalledTimes(1);
    });

    it('says the month’s imports from Find a score are spent, not the cloud-score cap, and links the plans', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');
        const { LimitReachedError } = await import('@/features/billing/limitErrors');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('clean-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });
        const onUpgrade = vi.fn();
        const importLimit = new LimitReachedError({
            code: 'limit_reached',
            metric: 'smart_imports',
            limit: 2,
            tier: 'free',
        });

        await renderBrowser(
            { onImportImslp, importLimit, onUpgrade },
            `/search?work=${encodeURIComponent(work.title)}`,
        );
        await waitForWork();

        expect(screen.getByRole('button', { name: 'Add to my library' })).toBeDisabled();
        expect(screen.getByText(/You have used your 2 free imports from Find a score this month/)).toBeInTheDocument();
        expect(screen.queryByText(/Cloud-score limit reached/)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'see plans' }));
        expect(onUpgrade).toHaveBeenCalledTimes(1);
        expect(onImportImslp).not.toHaveBeenCalled();
    });

    it('names editions by publisher and year, tags only what is not the complete score, and shows a file name only to tell twins apart', async () => {
        const { screen, within } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Bagatelle in A minor (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            imslpUrl: 'https://imslp.org/wiki/Fur_Elise',
            editions: [
                edition('WIMA.8c48-FESCo.pdf', {
                    publisher: 'Breitkopf und Härtel',
                    year: 1870,
                    description: 'Complete Score',
                }),
                edition('Fuer_E.pdf', { description: 'Für Elise' }),
                edition('PMLP1-wier_ihml_1.pdf', { publisher: 'Peters', year: 1900, description: 'Complete Score' }),
                edition('PMLP1-joined_document.pdf', { publisher: 'Peters', year: 1900 }),
                edition('cello.pdf', { publisher: 'Schott', year: 1910, arrangement: true }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();
        const list = await openEditionList();
        const row = (name: RegExp) => within(list).getByRole('radio', { name }).closest('li')!;

        expect(row(/Breitkopf und Härtel, 1870/)).not.toHaveTextContent('WIMA');
        expect(within(row(/Für Elise/)).getByText('Unknown publisher')).toBeInTheDocument();
        expect(within(row(/Für Elise/)).getByText('Für Elise')).toBeInTheDocument();
        expect(within(row(/wier ihml 1/)).getByText('Peters, 1900')).toBeInTheDocument();
        expect(within(row(/joined document/)).getByText('Peters, 1900')).toBeInTheDocument();
        expect(within(row(/Schott, 1910/)).getByText('Arrangement')).toBeInTheDocument();
        expect(row(/Schott, 1910/)).not.toHaveTextContent('cello');
        expect(screen.queryByText(/Complete Score/)).not.toBeInTheDocument();
    });

    it('keeps a single Back with the title at the top of the work panel, not in the page chrome', async () => {
        const { screen, within } = await import('@testing-library/react');
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('clean-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
        const title = screen.getByRole('heading', { level: 2, name: 'Nocturnes, Op.9' });
        const panel = title.closest<HTMLElement>('.imslp-panel-view');
        expect(panel).not.toBeNull();
        const back = within(panel!).getByRole('button', { name: 'Back' });
        // Back comes first in the panel, right before the title.
        expect(panel!.firstElementChild).toBe(back);
        expect(back.nextElementSibling).toBe(title);
        // One edition: nothing else to choose, so no toggle.
        expect(screen.queryByRole('button', { name: /Choose a different edition/ })).not.toBeInTheDocument();
    });

    it('keeps the full legal wording one disclosure away, beside Add', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [edition('clean-scan.pdf')],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        expect(screen.getByText(/Public-domain status varies by country\./)).toBeVisible();
        const learnMore = screen.getByRole('button', { name: 'Learn more' });
        const full = screen.getByText(/Files are not guaranteed to be public domain in your country/);
        expect(learnMore).toHaveAttribute('aria-expanded', 'false');
        expect(learnMore).toHaveAttribute('aria-controls', full.id);
        expect(full).not.toBeVisible();

        await userEvent.click(learnMore);
        expect(learnMore).toHaveAttribute('aria-expanded', 'true');
        expect(full).toBeVisible();
        expect(full).toHaveTextContent(
            'By downloading you acknowledge you understand and agree to obey the copyright laws of your country.',
        );
    });

    it('opens and closes the other editions from the keyboard, and the toggle names the list it controls', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            imslpUrl: 'https://imslp.org/wiki/Nocturnes',
            editions: [
                edition('a.pdf', { publisher: 'Peters' }),
                edition('b.pdf', { publisher: 'Schott' }),
                edition('c.pdf', { publisher: 'Durand' }),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);

        await renderBrowser({}, `/search?work=${encodeURIComponent(work.title)}`);
        await waitForWork();

        const toggle = screen.getByRole('button', { name: 'Choose a different edition (2)' });
        toggle.focus();
        await userEvent.keyboard('{Enter}');
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const group = screen.getByRole('group', { name: 'PDF editions' });
        expect(toggle).toHaveAttribute('aria-controls', group.id);

        // Tab moves into the radio group; arrows change the choice, which the card follows.
        await userEvent.tab();
        expect(screen.getByRole('radio', { name: /Peters/ })).toHaveFocus();
        await userEvent.keyboard('{ArrowDown}');
        expect(screen.getByRole('radio', { name: /Schott/ })).toBeChecked();
        expect(await editionCard()).toHaveTextContent('Schott');

        await userEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('radio')).not.toBeInTheDocument();
        expect(await editionCard()).toHaveTextContent('Schott');
    });

    it('searches when Nocturne is added and names both chips plus total', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Nocturnes, Op.9 (Chopin, Frédéric)', 9)],
                mode: 'browse',
                total: 61,
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Form' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Nocturne' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        expect(screen.queryByRole('heading', { name: 'Popular' })).not.toBeInTheDocument();
        expect(await screen.findByText(/Piano · Nocturne · 61 scores/)).toBeInTheDocument();
        expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({
                filters: expect.objectContaining({ instruments: ['piano'], forms: ['nocturne'] }),
            }),
        );
    });

    it('browses a key chip as an IMSLP category, even with Piano off', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Nocturne in C-sharp minor, B.49 (Chopin, Frédéric)', 49)],
                mode: 'browse',
                total: 647,
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Piano' }));
        await userEvent.click(screen.getByRole('button', { name: 'Key' }));
        await userEvent.click(await screen.findByRole('button', { name: 'C-sharp minor' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        expect(searchSpy.mock.calls.at(-1)?.[0]).toBe('');
        expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({ filters: expect.objectContaining({ keys: ['c-sharp-minor'] }) }),
        );
        expect(screen.queryByRole('heading', { name: 'Popular' })).not.toBeInTheDocument();
        expect(await screen.findByText(/C-sharp minor · 647 scores/)).toBeInTheDocument();
        expect(screen.queryByText('No matches')).not.toBeInTheDocument();
    });

    it('names a missing key category by its chip label in the index-building copy', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({ results: [], mode: 'browse', total: 0, indexReady: false, notReady: ['E-flat major'] }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Key' }));
        await userEvent.click(await screen.findByRole('button', { name: 'E-flat major' }));

        expect(await screen.findByText('Preparing scores')).toBeInTheDocument();
        expect(
            screen.getByText('We’re still preparing scores for E-flat major. Try typing a title.'),
        ).toBeInTheDocument();
    });

    it('sends both composer ids when two composers are selected', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)', 14)],
                mode: 'browse',
                total: 2,
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Composer' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Bach' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Beethoven' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({
                filters: expect.objectContaining({
                    composerCategories: ['Bach, Johann Sebastian', 'Beethoven, Ludwig van'],
                }),
            }),
        );
    });

    it('renders the index-building copy when the snapshot is not ready', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [],
                mode: 'browse',
                total: 0,
                indexReady: false,
                notReady: ['Baroque'],
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Era' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Baroque' }));

        expect(await screen.findByText('Preparing scores')).toBeInTheDocument();
        expect(screen.getByText(/We’re still preparing scores for Baroque/)).toBeInTheDocument();
        expect(screen.queryByText('No matches')).not.toBeInTheDocument();
    });

    it('names every chip whose category is missing, as chips — not raw IMSLP titles', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [],
                mode: 'browse',
                total: 0,
                indexReady: false,
                notReady: ['For piano', 'For piano (arr)', 'Nocturnes'],
            }),
        );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Form' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Nocturne' }));

        expect(await screen.findByText('Preparing scores')).toBeInTheDocument();
        expect(
            screen.getByText('We’re still preparing scores for Piano and Nocturne. Try typing a title.'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/for For piano/)).not.toBeInTheDocument();
    });

    it("labels the Piano chip's keyboard categories as Piano until the sync walks them", () => {
        // A Piano-only browse whose keyboard categories have no snapshot yet.
        expect(
            labelsForCategories([
                'For keyboard',
                'For keyboard (arr)',
                'For harpsichord',
                'For harpsichord (arr)',
                'For clavichord',
                'Nocturnes',
            ]),
        ).toEqual(['Piano', 'Nocturne']);
    });

    it('stops offering a seventh chip in a dimension and says why', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockResolvedValue(searchOk({ results: [], mode: 'browse', total: 0, indexReady: false, notReady: [] }));

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Composer' }));
        for (const name of ['Bach', 'Beethoven', 'Mozart', 'Chopin', 'Schubert', 'Brahms']) {
            await userEvent.click(await screen.findByRole('button', { name }));
        }

        expect(screen.getByRole('button', { name: 'Liszt' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Chopin' })).toBeEnabled();
        expect(screen.getByText(/Up to 6 per group/)).toBeInTheDocument();
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        const opts = searchSpy.mock.calls.at(-1)?.[1];
        const sent = typeof opts === 'object' ? (opts.filters?.composerCategories ?? []) : [];
        expect(sent).toHaveLength(6);
    });

    it('issues a second request with offset when Show more is clicked', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockResolvedValueOnce(
                searchOk({
                    results: [hit('Nocturnes, Op.9 (Chopin, Frédéric)', 9)],
                    mode: 'browse',
                    total: 2,
                    hasMore: true,
                }),
            )
            .mockResolvedValueOnce(
                searchOk({
                    results: [hit('Nocturnes, Op.27 (Chopin, Frédéric)', 27)],
                    mode: 'browse',
                    total: 2,
                    hasMore: false,
                }),
            );

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Form' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Nocturne' }));
        expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(2);
        });
        expect(searchSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ offset: 1 }));
    });

    it('issues typed Show more with offset and a stable limit', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockResolvedValueOnce(
                searchOk({
                    results: [hit('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)', 14)],
                    mode: 'search',
                    total: 2,
                    hasMore: true,
                }),
            )
            .mockResolvedValueOnce(
                searchOk({
                    results: [hit('Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)', 13)],
                    mode: 'search',
                    total: 2,
                    hasMore: false,
                }),
            );

        await renderBrowser();
        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'beethoven sonata',
        );
        expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalledTimes(2);
        });
        expect(searchSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ offset: 1, limit: 100 }));
    });

    it('shows an inferred Romantic chip for a typed year query', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [hit('Nocturnes, Op.9 (Chopin, Frédéric)', 9)],
                period: { eraIds: ['romantic'], source: 'query' },
            }),
        );

        await renderBrowser();
        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'chopin 1831',
        );
        await screen.findByText('Best matches');
        await userEvent.click(screen.getByRole('button', { name: 'Era' }));
        expect(await screen.findByRole('button', { name: 'Romantic' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Early 20th century' })).toBeInTheDocument();
        // The status line names the era in force, matching the pressed chip.
        expect(screen.getByText('Piano · Romantic · 1 result')).toBeInTheDocument();
    });

    it('marks short query words only where they stand alone, and shows snippets as plain text', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            searchOk({
                results: [
                    { ...hit('Au Clair de la Lune, Op.41 (Vītols, Jāzeps)', 1), snippet: '"Au Clair de la Lune" & co' },
                    hit('Préludes, Livre 2 (Debussy, Claude)', 2),
                ],
            }),
        );

        await renderBrowser();
        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'Clair de lune',
        );

        const vitols = (await screen.findAllByText((_, el) => el?.textContent === 'Au Clair de la Lune, Op.41'))[0]!;
        expect([...vitols.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Clair', 'de', 'Lune']);
        // The server already decoded entities; the client must not escape again.
        expect(screen.getByText('"Au Clair de la Lune" & co')).toBeInTheDocument();

        const debussy = screen.getByText('Debussy, Claude');
        expect(debussy.querySelector('mark')).toBeNull();
        expect(screen.getByText('Préludes, Livre 2').querySelector('mark')).toBeNull();
    });

    it('keeps Add, the legal line and a queued Cancel together in the sticky action footer', async () => {
        const { render, screen, within } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const { ImslpWorkPanel } = await import('@/features/imslp/ImslpWorkPanel');
        const work: ImslpWorkDetail = {
            title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            imslpUrl: 'https://imslp.org/wiki/Moonlight',
            editions: [edition('a.pdf'), edition('b.pdf')],
        };
        render(
            <ImslpWorkPanel
                work={work}
                selected={work.editions[0]!}
                download={{ kind: 'queued' }}
                busy={false}
                importing
                onBack={vi.fn()}
                onSelect={vi.fn()}
                onImportSelected={vi.fn()}
                onImportLocalPdf={vi.fn()}
                onCancelQueued={vi.fn()}
            />,
        );

        const footer = screen.getByRole('button', { name: 'Queued for download…' }).closest('.imslp-action-footer');
        expect(footer).not.toBeNull();
        const inFooter = within(footer as HTMLElement);
        expect(inFooter.getByText(/Public-domain status varies by country/)).toBeInTheDocument();
        expect(inFooter.getByRole('button', { name: 'Learn more' })).toBeInTheDocument();
        expect(inFooter.getByText(/Files are not guaranteed/)).toBeInTheDocument();
        expect(inFooter.getByRole('button', { name: 'Cancel import' })).toBeInTheDocument();
        // The open edition list scrolls with the page, past the footer — never inside it.
        await userEvent.click(screen.getByRole('button', { name: /Choose a different edition/ }));
        const list = screen.getByRole('list', { name: 'PDF editions' });
        expect(footer!.contains(list)).toBe(false);
        expect(list.closest('[class*="overflow-y-auto"]')).toBeNull();

        // jsdom has no layout, so pin the rule that does the work: below sm
        // (390x667 put Add ~30px under the fold) the footer sticks to the bottom.
        const { readFileSync } = await import('node:fs');
        const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');
        const rule = css.match(/@media \(max-width: 39\.99rem\) \{\s*\.imslp-action-footer \{([^}]*)\}/)?.[1];
        expect(rule).toMatch(/position:\s*sticky/);
        expect(rule).toMatch(/bottom:\s*0/);
        expect(rule).toMatch(/background:/);
    });

    describe('card view', () => {
        beforeEach(() => {
            window.localStorage.removeItem('cleffy:imslp-view');
        });

        it('defaults to rows, with the view toggle in the sticky header', async () => {
            const { screen } = await import('@testing-library/react');

            await renderBrowser();

            expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'false');
            expect(screen.getByText('Moonlight Sonata').closest('ul')?.className ?? '').not.toContain('grid-cols');
        });

        it('switches Popular to cards with real tags, and remembers the choice', async () => {
            const { screen, within } = await import('@testing-library/react');
            const userEvent = (await import('@testing-library/user-event')).default;

            await renderBrowser();
            await userEvent.click(screen.getByRole('button', { name: 'Grid view' }));

            expect(window.localStorage.getItem('cleffy:imslp-view')).toBe('grid');
            expect(screen.getAllByText('Moonlight Sonata')[0]!.closest('ul')?.className).toContain('grid-cols-2');

            // Tags come from the work's own curated metadata, humanized through
            // the facet tables. Scoped with within() — a bare "Piano" also
            // lives in the status line and the filter chips.
            const card = screen.getByRole('button', { name: /Moonlight Sonata/ });
            expect(within(card).getByText('Piano')).toBeInTheDocument();
            expect(within(card).getByText('Sonata')).toBeInTheDocument();
            expect(within(card).getByText('Classical')).toBeInTheDocument();
            expect(within(card).getByText('C-sharp minor')).toBeInTheDocument();
        });

        it('starts in cards when the choice was saved', async () => {
            const { screen } = await import('@testing-library/react');
            window.localStorage.setItem('cleffy:imslp-view', 'grid');

            await renderBrowser();

            expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getAllByText('Moonlight Sonata')[0]!.closest('ul')?.className).toContain('grid-cols-2');
        });

        it('opens a work from a Popular card', async () => {
            const { screen } = await import('@testing-library/react');
            const userEvent = (await import('@testing-library/user-event')).default;
            const api = await import('@/features/imslp/imslpApi');

            const title = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
            const workSpy = vi.spyOn(api, 'fetchImslpWork').mockResolvedValue({
                title,
                composer: 'Beethoven, Ludwig van',
                imslpUrl: 'https://imslp.org/wiki/Moonlight',
                editions: [edition('clean-scan.pdf')],
            });
            window.localStorage.setItem('cleffy:imslp-view', 'grid');

            await renderBrowser();
            await userEvent.click(screen.getByRole('button', { name: /Moonlight Sonata/ }));

            await screen.findByRole('button', { name: 'Back' });
            expect(workSpy).toHaveBeenCalledWith(title);
        });

        it('renders search hits as cards with highlights and snippets', async () => {
            const { screen, within } = await import('@testing-library/react');
            const userEvent = (await import('@testing-library/user-event')).default;
            const api = await import('@/features/imslp/imslpApi');

            vi.spyOn(api, 'searchImslp').mockResolvedValue(
                searchOk({
                    results: Array.from({ length: 10 }, (_, i) => ({
                        ...hit(
                            i === 0
                                ? 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)'
                                : `Other Work ${i} (Composer, Name)`,
                            1458 + i,
                        ),
                        snippet: 'A snippet about the sonata form.',
                    })),
                }),
            );
            window.localStorage.setItem('cleffy:imslp-view', 'grid');

            await renderBrowser();
            await userEvent.type(
                screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
                'beethoven sonata',
            );

            expect(await screen.findByText('Best matches')).toBeInTheDocument();
            expect(screen.getByText('More scores')).toBeInTheDocument();

            // The highlight <mark>s split the title into chunks, which the
            // accessible-name computation joins without spaces — so find the
            // card by its stitched-together text, not by role name.
            const title = screen.getAllByText((_, el) => el?.textContent === 'Piano Sonata No.14, Op.27 No.2')[0]!;
            const card = title.closest('button')!;
            // The typed tokens are highlighted in the card's readable title.
            expect(card.querySelector('mark')).not.toBeNull();
            expect(within(card).getByText('A snippet about the sonata form.')).toBeInTheDocument();
        });

        it('disables the cards — but never the view toggle — while the library is busy', async () => {
            const { screen } = await import('@testing-library/react');
            window.localStorage.setItem('cleffy:imslp-view', 'grid');

            await renderBrowser({ busy: true });

            const card = screen.getByRole('button', { name: /Moonlight Sonata/ });
            expect(card).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Grid view' })).toBeEnabled();
            expect(screen.getByRole('button', { name: 'List view' })).toBeEnabled();
        });
    });
});
