import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { NotFoundPage } from '@/features/marketing/NotFoundPage';

const renderPage = () =>
    render(
        <MemoryRouter initialEntries={['/nowhere']}>
            <NotFoundPage />
        </MemoryRouter>,
    );

describe('NotFoundPage', () => {
    it('says the page is silent and offers the library and home', () => {
        renderPage();

        expect(screen.getByRole('heading', { level: 1, name: 'Tacet.' })).toBeInTheDocument();
        expect(screen.getByText('This page is silent — there’s nothing at this address.')).toBeInTheDocument();
        expect(screen.getByText('a whole bar of rest')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Go to your library' })).toHaveAttribute('href', '/library');
        expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
        expect(screen.getByRole('link', { name: 'Cleffy' })).toHaveAttribute('href', '/');
    });

    it('lists the legal links', () => {
        renderPage();

        expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
        expect(screen.getByRole('link', { name: 'Report content' })).toHaveAttribute('href', '/report');
    });

    it('keeps the staff motif out of the accessibility tree', () => {
        const { container } = renderPage();

        const staff = container.querySelector('main > div:nth-child(2) > div') as HTMLElement;
        expect(staff).toHaveAttribute('aria-hidden', 'true');
        expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
            'Cleffy',
            'Go to your library',
            'Back to home',
            'Privacy',
            'Children’s privacy',
            'Terms',
            'Refunds',
            'Copyright',
            'Report content',
        ]);
    });
});
