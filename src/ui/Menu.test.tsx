import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    cleanup();
});

/** Fresh copies of the modules, so the menu's chunk has not been loaded yet. */
const coldModules = async () => {
    vi.resetModules();
    const [{ Menu, MenuItem, MenuSeparator }, { menuBaseModule }] = await Promise.all([
        import('@/ui/Menu'),
        import('@/ui/lazyPrimitives'),
    ]);
    return { Menu, MenuItem, MenuSeparator, menuBaseModule };
};

describe('Menu, lazily loaded', () => {
    it('stands in with a matching trigger, and swaps to the real one once the chunk is in', async () => {
        const { Menu, MenuItem, menuBaseModule } = await coldModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮" triggerTitle="Actions">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        expect(menuBaseModule.get()).toBeNull();
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        expect(standIn).toHaveAttribute('aria-haspopup', 'menu');
        expect(standIn).toHaveAttribute('aria-expanded', 'false');
        expect(standIn).toHaveAttribute('title', 'Actions');
        expect(standIn).toHaveClass('trigger');

        await act(() => menuBaseModule.load());
        const trigger = screen.getByRole('button', { name: 'Score actions' });
        expect(trigger).not.toBe(standIn);
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveClass('trigger');
    });

    it('warms the chunk on hover and on focus', async () => {
        const { Menu, MenuItem, menuBaseModule } = await coldModules();
        render(
            <Menu label="Account" triggerClassName="trigger" triggerContent="MH">
                <MenuItem>Account</MenuItem>
            </Menu>,
        );
        fireEvent.pointerEnter(screen.getByRole('button', { name: 'Account' }));
        await waitFor(() => expect(menuBaseModule.get()).not.toBeNull());
    });

    it('keeps focus on the trigger when a focused stand-in is swapped out', async () => {
        const { Menu, MenuItem, menuBaseModule } = await coldModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        act(() => screen.getByRole('button', { name: 'Score actions' }).focus());
        // Focus warms the chunk; once it is in, the real trigger has focus.
        await waitFor(() => expect(menuBaseModule.get()).not.toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Score actions' })));
        expect(document.activeElement).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('opens on a press that came before the chunk, once it is in', async () => {
        const { Menu, MenuItem, MenuSeparator } = await coldModules();
        const onRename = vi.fn();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem onClick={onRename}>Rename</MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled>
                    Delete
                </MenuItem>
            </Menu>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Score actions' }));
        expect(await screen.findByRole('menu')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Score actions' })).toHaveAttribute('aria-expanded', 'true');
        // Disabled items stay focusable, marked aria-disabled.
        expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
        await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
        expect(onRename).toHaveBeenCalledTimes(1);
    });

    it('asks a controlled menu to open on an early press', async () => {
        const { Menu, MenuItem } = await coldModules();
        const onOpenChange = vi.fn();
        const Controlled = () => {
            const [open, setOpen] = useState(false);
            return (
                <Menu
                    label="Account"
                    triggerClassName="trigger"
                    triggerContent="MH"
                    open={open}
                    onOpenChange={(next) => {
                        onOpenChange(next);
                        setOpen(next);
                    }}
                >
                    <MenuItem>Settings</MenuItem>
                </Menu>
            );
        };
        render(<Controlled />);
        fireEvent.click(screen.getByRole('button', { name: 'Account' }));
        expect(onOpenChange).toHaveBeenCalledWith(true);
        expect(await screen.findByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    });

    it('holds the swap while a press is down on the stand-in, so its click is not lost', async () => {
        const { Menu, MenuItem, menuBaseModule } = await coldModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        fireEvent.pointerDown(standIn, { button: 0 });
        await act(() => menuBaseModule.load());
        // Loaded mid-press: the stand-in stays until the press resolves...
        expect(screen.getByRole('button', { name: 'Score actions' })).toBe(standIn);
        fireEvent.pointerUp(standIn, { button: 0 });
        fireEvent.click(standIn);
        // ...and its click opens the menu.
        expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    });

    it('does not swap the trigger out from under a resting pointer', async () => {
        const { Menu, MenuItem, menuBaseModule } = await coldModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        fireEvent.pointerEnter(standIn);
        await act(() => menuBaseModule.load());
        expect(screen.getByRole('button', { name: 'Score actions' })).toBe(standIn);
        fireEvent.pointerLeave(standIn);
        expect(screen.getByRole('button', { name: 'Score actions' })).not.toBe(standIn);
    });

    it('opens from a hover and a click, as a pointer does it, on first use', async () => {
        const { Menu, MenuItem } = await coldModules();
        const user = userEvent.setup();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        await user.click(screen.getByRole('button', { name: 'Score actions' }));
        expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
        // Escape closes it and puts focus back on the (now real) trigger.
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Score actions' }));
    });

    it('does not open, or swap in, a disabled menu on a press', async () => {
        const { Menu, MenuItem } = await coldModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮" disabled>
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        expect(standIn).toBeDisabled();
        await userEvent.click(standIn);
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
});
