import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PageColumns } from '@/features/viewer/geometry';
import { PageLayoutMenu } from '@/features/viewer/PageLayoutMenu';
import { menuBaseModule } from '@/ui/lazyPrimitives';

beforeAll(async () => {
    await menuBaseModule.load();
});

afterEach(cleanup);

const renderMenu = (initial: PageColumns = 1, initialCover = false) => {
    const onColumns = vi.fn();
    const onCover = vi.fn();
    const Harness = () => {
        const [columns, setColumns] = useState<PageColumns>(initial);
        const [cover, setCover] = useState(initialCover);
        return (
            <>
                <p>The score</p>
                <PageLayoutMenu
                    pageColumns={columns}
                    onPageColumnsChange={(next) => {
                        onColumns(next);
                        setColumns(next);
                    }}
                    spreadCover={cover}
                    onSpreadCoverChange={(next) => {
                        onCover(next);
                        setCover(next);
                    }}
                    triggerClassName="h-11 w-11"
                />
            </>
        );
    };
    render(<Harness />);
    return { onColumns, onCover, user: userEvent.setup() };
};

const trigger = () => screen.getByRole('button', { name: /^Page layout/ });
const menu = () => screen.queryByRole('menu', { name: 'Page layout' });
const single = () => screen.getByRole('menuitemradio', { name: 'Single page' });
const two = () => screen.getByRole('menuitemradio', { name: 'Two pages' });
/** Presses the layout button and waits for its menu. */
const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(trigger());
    return screen.findByRole('menu', { name: 'Page layout' });
};
const cover = () => screen.queryByRole('menuitemcheckbox', { name: 'Start with cover page' });

describe('PageLayoutMenu', () => {
    it('is one button, named for the layout showing, with the menu closed', () => {
        renderMenu(2);
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(trigger()).toHaveAccessibleName('Page layout: Two pages');
        expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
        expect(menu()).toBeNull();
    });

    it('opens a menu of the two layouts, the one showing checked, and no cover option in single page', async () => {
        const { user } = renderMenu(1);
        expect(await openMenu(user)).toBeInTheDocument();
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('group', { name: 'Pages per row' })).toContainElement(single());
        expect(single()).toHaveAttribute('aria-checked', 'true');
        expect(two()).toHaveAttribute('aria-checked', 'false');
        expect(cover()).toBeNull();
    });

    it('switches the layout and closes on a choice', async () => {
        const { user, onColumns } = renderMenu(1);
        await openMenu(user);
        await user.click(two());
        expect(onColumns).toHaveBeenLastCalledWith(2);
        await waitFor(() => expect(menu()).toBeNull());
        expect(trigger()).toHaveAccessibleName('Page layout: Two pages');
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('does nothing when the layout already showing is chosen again, and still closes', async () => {
        const { user, onColumns } = renderMenu(2);
        await openMenu(user);
        await user.click(two());
        expect(onColumns).not.toHaveBeenCalled();
        await waitFor(() => expect(menu()).toBeNull());
    });

    it('offers Start with cover page in two-page mode only, as a checkbox item that closes the menu', async () => {
        const { user, onCover } = renderMenu(2);
        await openMenu(user);
        expect(cover()).toHaveAttribute('aria-checked', 'false');
        expect(cover()).toHaveAttribute('title', expect.stringContaining('2|3'));
        expect(screen.getByRole('group', { name: 'Pages per row' })).not.toContainElement(cover());
        await user.click(cover() as HTMLElement);
        expect(onCover).toHaveBeenLastCalledWith(true);
        await waitFor(() => expect(menu()).toBeNull());

        await openMenu(user);
        expect(cover()).toHaveAttribute('aria-checked', 'true');
        await user.click(single());
        await waitFor(() => expect(menu()).toBeNull());
        await openMenu(user);
        expect(cover()).toBeNull();
    });

    it('closes on a press outside, changing nothing', async () => {
        const { user, onColumns, onCover } = renderMenu(2);
        expect(await openMenu(user)).toBeInTheDocument();
        await user.click(screen.getByText('The score'));
        await waitFor(() => expect(menu()).toBeNull());
        expect(onColumns).not.toHaveBeenCalled();
        expect(onCover).not.toHaveBeenCalled();
    });

    it('works from the keyboard: Enter opens, arrows move, Enter chooses, Escape closes back to the button', async () => {
        const { user, onColumns } = renderMenu(1);
        act(() => trigger().focus());
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('menu', { name: 'Page layout' })).toBeInTheDocument();
        await waitFor(() => expect(single()).toHaveFocus());
        await user.keyboard('{ArrowDown}');
        expect(two()).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(onColumns).toHaveBeenLastCalledWith(2);
        await waitFor(() => expect(menu()).toBeNull());
        await waitFor(() => expect(trigger()).toHaveFocus());

        await user.keyboard('{Enter}');
        expect(await screen.findByRole('menu', { name: 'Page layout' })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await waitFor(() => expect(menu()).toBeNull());
        expect(trigger()).toHaveFocus();
        expect(onColumns).toHaveBeenCalledTimes(1);
    });
});
