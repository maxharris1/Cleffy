import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImslpBrowserProps } from '@/features/imslp/ImslpBrowser';
import type { ImslpEdition, ImslpSearchResponse, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayEditionName,
    displayWorkTitle,
    editionAvailability,
    formatBytes,
    recommendEdition,
    searchTokens,
    splitSearchResults,
    suggestedPdfName,
} from '@/features/imslp/imslpDisplay';
import { groupPopularByComposer, POPULAR_WORKS, popularWorkTags } from '@/features/imslp/popularWorks';
import { buildSearchFilters, hasActiveFilters } from '@/features/imslp/searchFacets';

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

const searchOk = (overrides: Partial<ImslpSearchResponse> & Pick<ImslpSearchResponse, 'results'>): ImslpSearchResponse => ({
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
    it('formats byte sizes', () => {
        expect(formatBytes(null)).toBe('');
        expect(formatBytes(500)).toBe('500 B');
        expect(formatBytes(2048)).toBe('2 KB');
        expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
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

    it('cleans edition filenames', () => {
        expect(displayEditionName('PMLP01458-Beethoven_Moonlight.pdf')).toBe('Beethoven Moonlight');
    });

    it('recommends a mid-size edition over tiny or huge files', () => {
        const pick = recommendEdition([
            { filename: 'tiny.pdf', size: 12_000 },
            { filename: 'good-urtext.pdf', size: 1_800_000 },
            { filename: 'huge-complete.pdf', size: 40_000_000 },
        ]);
        expect(pick?.filename).toBe('good-urtext.pdf');
    });

    it('never recommends a restricted or license-unknown edition', () => {
        const pick = recommendEdition([
            edition('henle-urtext.pdf', { downloadable: false, license: 'pd', restriction: 'Non-PD US' }),
            edition('mystery.pdf', { license: 'unknown' }),
            edition('plain-scan.pdf', { size: 900_000 }),
        ]);
        expect(pick?.filename).toBe('plain-scan.pdf');
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
        expect(screen.getByText('More from IMSLP')).toBeInTheDocument();
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
        expect(screen.getByText('Piano · Searching IMSLP…')).toBeInTheDocument();
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

        expect(await screen.findByText('IMSLP is down')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        // Prior results stay; the "No matches" empty state must not appear.
        expect(screen.getByText('Best matches')).toBeInTheDocument();
        expect(screen.queryByText('No matches')).not.toBeInTheDocument();
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
                        releaseFirst = () =>
                            resolve(searchOk({ results: [hit('Stale Result (Old, Query)', 1)] }));
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

    it('opens a work from ?work=, orders restricted editions last, and gates import on consent', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const work: ImslpWorkDetail = {
            title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            imslpUrl: 'https://imslp.org/wiki/Moonlight',
            editions: [
                edition('restricted-henle.pdf', {
                    downloadable: false,
                    restriction: 'Non-PD US',
                }),
                edition('clean-scan.pdf'),
            ],
        };
        vi.spyOn(api, 'fetchImslpWork').mockResolvedValue(work);
        const onImportImslp = vi.fn().mockResolvedValue({ ok: true });

        await renderBrowser({ onImportImslp }, `/search?work=${encodeURIComponent(work.title)}`);

        await screen.findByText('Choose a PDF edition');
        expect(screen.getByText('2 available — 1 downloadable directly. Recommended edition selected.')).toBeInTheDocument();

        // The clean scan is recommended + auto-selected; the restricted row is
        // disabled, badged, and sorted after it.
        const radios = screen.getAllByRole('radio');
        expect(radios).toHaveLength(2);
        expect(radios[0]).toBeChecked();
        expect(radios[1]).toBeDisabled();
        expect(screen.getByText('Non-PD US')).toBeInTheDocument();

        // Import is held until the disclaimer is actually acknowledged.
        const importButton = screen.getByRole('button', { name: 'Add to my library' });
        expect(importButton).toBeDisabled();
        await userEvent.click(screen.getByRole('checkbox'));
        expect(importButton).toBeEnabled();
        await userEvent.click(importButton);
        await waitFor(() => {
            expect(onImportImslp).toHaveBeenCalledWith('clean-scan.pdf', work.title, true);
        });
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

        await screen.findByText('Choose a PDF edition');
        expect(screen.getByText(/None of these editions can be imported automatically/)).toBeInTheDocument();
        expect(screen.getByText('Choose downloaded PDF')).toBeInTheDocument();
        // No import button, no consent checkbox — there is nothing to import.
        expect(screen.queryByRole('button', { name: 'Add to my library' })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
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

        expect(await screen.findByText('Index still building')).toBeInTheDocument();
        expect(screen.getByText(/IMSLP index is still being built for Baroque/)).toBeInTheDocument();
        expect(screen.queryByText('No matches')).not.toBeInTheDocument();
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

            await screen.findByText('Choose a PDF edition');
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
            expect(screen.getByText('More from IMSLP')).toBeInTheDocument();

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
