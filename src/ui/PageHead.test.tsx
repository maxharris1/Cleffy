import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PageHead } from '@/ui/PageHead';

afterEach(() => {
    cleanup();
});

describe('PageHead', () => {
    it('renders the title as the page heading with eyebrow, subtitle and action', () => {
        render(
            <PageHead
                eyebrow="Ada · 3 scores"
                title="Library"
                subtitle="Upload, organize, and share."
                action={<button type="button">Add</button>}
            />,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
        expect(screen.getByText('Ada · 3 scores')).toBeInTheDocument();
        expect(screen.getByText('Upload, organize, and share.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    });

    it('renders only the heading when nothing else is given', () => {
        render(<PageHead title="Account" />);
        const banner = screen.getByRole('banner');
        expect(banner).toHaveTextContent(/^Account$/);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});
