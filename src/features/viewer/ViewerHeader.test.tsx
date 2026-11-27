import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { useViewerStore } from '@/state/store';

beforeEach(() => {
    useViewerStore.setState({ penSeen: false, touchSeen: false });
});

afterEach(() => {
    cleanup();
    useViewerStore.setState({ penSeen: false, touchSeen: false });
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
});

describe('ViewerHeader, the pointers seen in the viewer', () => {
    const title = () => screen.getByRole('button', { name: 'Nocturne (Chopin)' });

    it('records a pen press on the title while no score viewport is mounted', () => {
        renderHeader();
        fireEvent.pointerDown(title(), { pointerType: 'pen' });
        expect(useViewerStore.getState()).toMatchObject({ penSeen: true, touchSeen: false });
    });

    it('records a touch once its tap has clicked', () => {
        renderHeader();
        fireEvent.pointerDown(document.body, { pointerType: 'touch' });
        fireEvent.pointerUp(document.body, { pointerType: 'touch' });
        expect(useViewerStore.getState().touchSeen).toBe(false);
        fireEvent(document.body, new PointerEvent('click', { bubbles: true, pointerType: 'touch' }));
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: true });
    });

    it('stops recording once the header unmounts', () => {
        const { unmount } = renderHeader();
        unmount();
        fireEvent.pointerDown(document.body, { pointerType: 'pen' });
        expect(useViewerStore.getState().penSeen).toBe(false);
    });
});
