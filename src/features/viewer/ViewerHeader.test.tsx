import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { useGhostVariant } from '@/ui/onInk';

afterEach(() => {
    cleanup();
});

const renderHeader = () =>
    render(
        <MemoryRouter>
            <ViewerHeader backTo="/library" backLabel="Back to library" title="Nocturne (Chopin)">
                <button type="button">Import marks</button>
                <button type="button">History</button>
                <button type="button">Notes</button>
                <button type="button">Export</button>
                <button type="button">Share</button>
            </ViewerHeader>
        </MemoryRouter>,
    );

describe('ViewerHeader', () => {
    it('renders the back link, title, and actions', () => {
        renderHeader();
        expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/library');
        expect(screen.getByText('Nocturne (Chopin)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    });

    it('lets the action cluster wrap instead of clipping off the viewport', () => {
        renderHeader();
        const nav = screen.getByRole('navigation', { name: 'Score' });
        expect(nav).toHaveClass('flex-wrap');
        expect(nav).toHaveClass('min-w-0');
        expect(nav).toHaveClass('flex-[1_1_100%]');
        expect(nav).toHaveClass('justify-start');
        expect(nav.className).toMatch(/lg:flex-\[0_1_auto\]/);
        expect(nav.className).toMatch(/lg:justify-end/);
    });

    it('sets the piece name in italic when the title reads "Composer — Piece"', () => {
        render(
            <MemoryRouter>
                <ViewerHeader backTo="/library" backLabel="Back to library" title="Beethoven — Für Elise" />
            </MemoryRouter>,
        );
        const title = screen.getByRole('button', { name: 'Beethoven — Für Elise' });
        expect(title.querySelector('em')).toHaveTextContent(/^Für Elise$/);
    });

    it('leaves any other title upright', () => {
        renderHeader();
        expect(screen.getByRole('button', { name: 'Nocturne (Chopin)' }).querySelector('em')).toBeNull();
    });

    it('keeps the primary action last in focus order, after the score actions', () => {
        render(
            <MemoryRouter>
                <ViewerHeader
                    backTo="/library"
                    backLabel="Back to library"
                    title="Nocturne"
                    primary={<button type="button">Share</button>}
                >
                    <button type="button">Export</button>
                </ViewerHeader>
            </MemoryRouter>,
        );
        const names = screen.getAllByRole('button').map((button) => button.textContent);
        expect(names).toEqual(['Nocturne', 'Export', 'Share']);
    });

    it('tells the controls inside it that they sit on ink', () => {
        const Probe = () => <span>{useGhostVariant()}</span>;
        render(
            <MemoryRouter>
                <Probe />
                <ViewerHeader backTo="/library" backLabel="Back to library" title="Nocturne">
                    <Probe />
                </ViewerHeader>
            </MemoryRouter>,
        );
        expect(screen.getByText('ghost')).toBeInTheDocument();
        expect(screen.getByText('inkGhost')).toBeInTheDocument();
    });
});
