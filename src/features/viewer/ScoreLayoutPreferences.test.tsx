import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScoreLayoutPreferences } from '@/features/viewer/ScoreLayoutPreferences';
import { useViewerStore } from '@/state/store';

afterEach(() => {
    cleanup();
    useViewerStore.setState({ pageColumns: 1, spreadCover: false });
    window.localStorage.clear();
});

describe('ScoreLayoutPreferences', () => {
    it('shows the saved layout, and offers the cover page only for two pages', async () => {
        const user = userEvent.setup();
        render(<ScoreLayoutPreferences />);
        const group = screen.getByRole('group', { name: 'Score layout' });
        expect(group).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'Single page' })).toBeChecked();
        expect(screen.queryByRole('checkbox', { name: /Start with cover page/ })).toBeNull();

        await user.click(screen.getByRole('radio', { name: 'Two pages side by side' }));
        expect(useViewerStore.getState().pageColumns).toBe(2);
        expect(window.localStorage.getItem('cleffy:page-columns')).toBe('2');
        const cover = screen.getByRole('checkbox', { name: /Start with cover page/ });
        expect(cover).not.toBeChecked();
        expect(cover).toHaveAccessibleDescription(expect.stringContaining('2|3'));

        await user.click(cover);
        expect(useViewerStore.getState().spreadCover).toBe(true);
        expect(window.localStorage.getItem('cleffy:spread-cover')).toBe('1');

        await user.click(screen.getByRole('radio', { name: 'Single page' }));
        expect(useViewerStore.getState().pageColumns).toBe(1);
        expect(screen.queryByRole('checkbox', { name: /Start with cover page/ })).toBeNull();
    });

    it('follows a change made in the viewer, and the next visit opens with it', async () => {
        render(<ScoreLayoutPreferences />);
        act(() => {
            useViewerStore.getState().setPageColumns(2);
            useViewerStore.getState().setSpreadCover(true);
        });
        expect(await screen.findByRole('radio', { name: 'Two pages side by side' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: /Start with cover page/ })).toBeChecked();

        vi.resetModules();
        const { useViewerStore: reloaded } = await import('@/state/store');
        expect(reloaded.getState()).toMatchObject({ pageColumns: 2, spreadCover: true });
    });
});
