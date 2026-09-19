import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { ViewerHeader } from '@/features/viewer/ViewerHeader';

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
                <button type="button">Share</button>
                <button type="button">Invite</button>
            </ViewerHeader>
        </MemoryRouter>,
    );

describe('ViewerHeader', () => {
    it('renders the back link, title, and actions', () => {
        renderHeader();
        expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/library');
        expect(screen.getByText('Nocturne (Chopin)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    });

    it('lets the action cluster wrap instead of clipping off the viewport', () => {
        renderHeader();
        const nav = screen.getByRole('navigation', { name: 'Score' });
        expect(nav).toHaveClass('flex-wrap');
        expect(nav).toHaveClass('min-w-0');
        expect(nav).toHaveClass('flex-[1_1_100%]');
        expect(nav).toHaveClass('justify-start');
        expect(nav.className).toMatch(/md:flex-\[0_1_auto\]/);
        expect(nav.className).toMatch(/md:justify-end/);
    });
});
