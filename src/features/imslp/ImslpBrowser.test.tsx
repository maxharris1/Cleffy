import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    displayEditionName,
    displayWorkTitle,
    formatBytes,
    recommendEdition,
    searchTokens,
    splitSearchResults,
    suggestedPdfName,
} from '@/features/imslp/imslpDisplay';
import { groupPopularByComposer, POPULAR_WORKS } from '@/features/imslp/popularWorks';
import {
    buildSearchFilters,
    filterSearchTokens,
    hasActiveFilters,
} from '@/features/imslp/searchFacets';

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
        expect(filterSearchTokens(filters)).toEqual(
            expect.arrayContaining(['Beethoven', 'piano', 'sonata']),
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

    it('shows popular works by default', async () => {
        const { render, screen } = await import('@testing-library/react');
        const { ImslpBrowser } = await import('@/features/imslp/ImslpBrowser');

        render(<ImslpBrowser onImportFile={vi.fn()} onImportImslp={vi.fn()} autoFocus={false} />);
        expect(screen.getByRole('heading', { name: 'Popular' })).toBeInTheDocument();
        expect(screen.getByText('Moonlight Sonata')).toBeInTheDocument();
        expect(screen.getByText('Für Elise')).toBeInTheDocument();
    });

    it('runs a debounced search and groups best matches', async () => {
        const { render, screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');
        const { ImslpBrowser } = await import('@/features/imslp/ImslpBrowser');

        vi.spyOn(api, 'searchImslp').mockResolvedValue(
            Array.from({ length: 10 }, (_, i) => ({
                title:
                    i === 0
                        ? 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)'
                        : `Other Work ${i} (Composer, Name)`,
                pageid: 1458 + i,
                snippet: '',
                composer: i === 0 ? 'Beethoven, Ludwig van' : 'Composer, Name',
                imslpUrl: `https://imslp.org/wiki/Work_${i}`,
            })),
        );

        render(<ImslpBrowser onImportFile={vi.fn()} onImportImslp={vi.fn()} autoFocus={false} />);

        await userEvent.type(
            screen.getByPlaceholderText('Beethoven moonlight, bolero, Chopin nocturne…'),
            'beethoven sonata',
        );

        await waitFor(() => {
            expect(api.searchImslp).toHaveBeenCalled();
        });
        expect(await screen.findByText('Best matches')).toBeInTheDocument();
        expect(screen.getByText('More from IMSLP')).toBeInTheDocument();
        expect(
            screen.getByText((_, el) => el?.textContent === 'Piano Sonata No.14, Op.27 No.2'),
        ).toBeInTheDocument();
    });

    it('sends facet filters when a tag is selected', async () => {
        const { render, screen, waitFor } = await import('@testing-library/react');
        const userEvent = (await import('@testing-library/user-event')).default;
        const api = await import('@/features/imslp/imslpApi');
        const { ImslpBrowser } = await import('@/features/imslp/ImslpBrowser');

        const searchSpy = vi.spyOn(api, 'searchImslp').mockResolvedValue([
            {
                title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
                pageid: 1458,
                snippet: '',
                composer: 'Beethoven, Ludwig van',
                imslpUrl: 'https://imslp.org/wiki/Moonlight',
            },
        ]);

        render(<ImslpBrowser onImportFile={vi.fn()} onImportImslp={vi.fn()} autoFocus={false} />);

        await userEvent.click(screen.getByRole('tab', { name: 'Instrument' }));
        await userEvent.click(screen.getByRole('option', { name: 'Piano' }));

        await waitFor(() => {
            expect(searchSpy).toHaveBeenCalled();
        });
        const lastCall = searchSpy.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('');
        expect(lastCall?.[1]).toEqual(
            expect.objectContaining({
                filters: expect.objectContaining({ instrument: 'piano' }),
            }),
        );
        expect(await screen.findByText('Best matches')).toBeInTheDocument();
    });
});
