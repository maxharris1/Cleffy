import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImslpBrowserProps } from '@/features/imslp/ImslpBrowser';
import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
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
import { groupPopularByComposer, POPULAR_WORKS } from '@/features/imslp/popularWorks';
import { buildSearchFilters, hasActiveFilters } from '@/features/imslp/searchFacets';

const hit = (title: string, pageid: number) => ({
    title,
    pageid,
    snippet: '',
    composer: title.match(/\(([^)]+)\)\s*$/)?.[1] ?? null,
    imslpUrl: `https://imslp.org/wiki/${pageid}`,
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
});

describe('search facets', () => {
    it('builds filters from selected facet ids', () => {
        const filters = buildSearchFilters({
            composerId: 'beethoven',
            instrumentId: 'piano',
            formId: 'sonata',
        });
        expect(filters.composerCategory).toBe('Beethoven, Ludwig van');
        expect(filters.instrument).toBe('piano');
        expect(filters.form).toBe('sonata');
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

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue({
            results: Array.from({ length: 10 }, (_, i) =>
                hit(
                    i === 0
                        ? 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)'
                        : `Other Work ${i} (Composer, Name)`,
                    1458 + i,
                ),
            ),
            filterRelaxed: false,
        });

        await renderBrowser();
        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'beethoven sonata',
        );

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        const lastCall = searchSpy.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('beethoven sonata');
        // Default Piano-only is not a typed-search hard filter.
        expect(lastCall?.[1]).toEqual(
            expect.objectContaining({
                filters: undefined,
            }),
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

        vi.spyOn(api, 'searchImslp').mockResolvedValue({
            results: [hit('Violin Sonata No.9, Op.47 (Beethoven, Ludwig van)', 47)],
            filterRelaxed: true,
        });

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Violin' }));
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'sonata');

        expect(await screen.findByText(/few violin-tagged scores were found/)).toBeInTheDocument();
        expect(screen.queryByText(/piano-tagged/)).not.toBeInTheDocument();
    });

    it('hides the sort chips for a key-only browse the server cannot sort', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        vi.spyOn(api, 'searchImslp').mockResolvedValue({
            results: [hit('Nocturne in C-sharp minor (Chopin, Frédéric)', 9)],
            filterRelaxed: false,
        });

        await renderBrowser();
        // Drop the default piano scope, then browse by key alone — Key is not a category.
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Piano' }));
        await userEvent.click(screen.getByRole('button', { name: 'Key' }));
        await userEvent.click(await screen.findByRole('button', { name: 'C-sharp minor' }));

        expect(await screen.findByText('Best matches')).toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Sort results' })).not.toBeInTheDocument();

        // A typed query takes the sortable text path, so the chips come back.
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'chopin');
        expect(await screen.findByRole('group', { name: 'Sort results' })).toBeInTheDocument();
    });

    it('sends a chosen instrument on a typed query, and drops Popular when a second chip is on', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue({
            results: [hit('Violin Sonata No.9, Op.47 (Beethoven, Ludwig van)', 47)],
            filterRelaxed: false,
        });

        await renderBrowser();
        expect(screen.getByRole('heading', { name: 'Popular' })).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Form' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Nocturne' }));
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        expect(screen.queryByRole('heading', { name: 'Popular' })).not.toBeInTheDocument();
        expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({ filters: expect.objectContaining({ instrument: 'piano', form: 'nocturne' }) }),
        );

        searchSpy.mockClear();
        await userEvent.click(screen.getByRole('button', { name: 'Instrument' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Violin' }));
        await userEvent.type(screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'), 'sonata');
        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({ filters: expect.objectContaining({ instrument: 'violin' }) }),
        );
    });

    it('lists Early 20th century and Modern as separate era chips', async () => {
        const { screen } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;

        await renderBrowser();
        await userEvent.click(screen.getByRole('button', { name: 'Era' }));
        expect(await screen.findByRole('button', { name: 'Early 20th century' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Modern' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Baroque' })).toBeInTheDocument();
    });

    it('keeps prior results and shows an error — not the empty state — when a search fails', async () => {
        const { screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');

        const searchSpy = vi
            .spyOn(api, 'searchImslp')
            .mockResolvedValueOnce({ results: [hit('Nocturnes, Op.9 (Chopin, Frédéric)', 7)], filterRelaxed: false })
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
                            resolve({ results: [hit('Stale Result (Old, Query)', 1)], filterRelaxed: false });
                    }),
            )
            .mockResolvedValueOnce({ results: [hit('Fresh Result (New, Query)', 2)], filterRelaxed: false });

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
});
