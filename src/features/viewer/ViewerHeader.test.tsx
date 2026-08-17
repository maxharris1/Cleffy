import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewerHeader } from '@/features/viewer/ViewerHeader';

const setMdUp = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: query.includes('768') ? matches : false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }),
    });
};

const renderHeader = (overflow?: ReactNode) =>
    render(
        <MemoryRouter>
            <ViewerHeader backTo="/library" backLabel="Back to library" title="Für Elise" overflow={overflow}>
                <span>Synced</span>
            </ViewerHeader>
        </MemoryRouter>,
    );

beforeEach(() => {
    setMdUp(true);
});

afterEach(() => {
    cleanup();
});

describe('ViewerHeader', () => {
    it('keeps back, title, and presence visible and shows overflow actions inline when wide', () => {
        setMdUp(true);
        renderHeader(<button type="button">Find handwritten notes</button>);
        expect(screen.getByRole('link', { name: 'Back to library' })).toBeInTheDocument();
        expect(screen.getByText('Für Elise')).toBeInTheDocument();
        expect(screen.getByText('Synced')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Find handwritten notes' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    });

    it('moves infrequent actions into More at a narrow width', async () => {
        setMdUp(false);
        renderHeader(<button type="button">Find handwritten notes</button>);
        expect(screen.getByRole('link', { name: 'Back to library' })).toBeInTheDocument();
        expect(screen.getByText('Für Elise')).toBeInTheDocument();
        expect(screen.getByText('Synced')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Find handwritten notes' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'More' }));
        expect(screen.getByRole('button', { name: 'Find handwritten notes' })).toBeInTheDocument();
    });
});
