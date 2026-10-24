import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    cleanup();
    vi.doUnmock('@/ui/lazyPrimitives');
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

/**
 * Fresh modules whose menu chunk arrives only when the test says so: each
 * import of it (a prefetch, an open, a retry) waits on its own `imports` entry,
 * to be resolved with the real ui/MenuBase or rejected.
 */
const deferredModules = async () => {
    vi.resetModules();
    const imports: { resolve: () => void; reject: (error: unknown) => void }[] = [];
    vi.doMock('@/ui/lazyPrimitives', async () => {
        const { lazyModule } = await import('@/ui/lazyModule');
        const menuBase = await import('@/ui/MenuBase');
        return {
            menuBaseModule: lazyModule(
                () =>
                    new Promise<typeof menuBase>((resolve, reject) => {
                        imports.push({ resolve: () => resolve(menuBase), reject });
                    }),
            ),
        };
    });
    const [{ Menu, MenuItem }, staleChunk] = await Promise.all([import('@/ui/Menu'), import('@/lib/staleChunk')]);
    return { Menu, MenuItem, staleChunk, imports };
};

/** What Chromium rejects an import with when its chunk is gone (a deploy replaced it). */
const missingChunk = () =>
    new TypeError('Failed to fetch dynamically imported module: https://dev.cleffy.io/assets/MenuBase-old.js');

describe('Menu, when its chunk will not load', () => {
    afterEach(() => {
        window.sessionStorage.clear();
        vi.restoreAllMocks();
    });

    const renderMenu = ({ Menu, MenuItem }: Awaited<ReturnType<typeof deferredModules>>) =>
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
            </Menu>,
        );

    it('reloads for the current build when an open joins a prefetch that meets a stale chunk', async () => {
        const modules = await deferredModules();
        const { staleChunk, imports } = modules;
        renderMenu(modules);
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        // Hover starts the prefetch; the press joins the same import.
        fireEvent.pointerEnter(standIn);
        fireEvent.click(standIn);
        expect(imports).toHaveLength(1);
        await act(async () => imports[0]?.reject(missingChunk()));
        // The prefetch's failure is dropped, the open's is not: the page reloads.
        await waitFor(() => expect(staleChunk.isStaleChunkReloadPending()).toBe(true));
        expect(window.sessionStorage.getItem('cleffy:stale-chunk-reload-at')).not.toBeNull();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        staleChunk.resetStaleChunkStateForTests();
    });

    it('says the menu could not open when it cannot reload, and opens on a press once the chunk loads', async () => {
        const modules = await deferredModules();
        const { staleChunk, imports } = modules;
        // A reload for a stale chunk moments ago: another would only loop.
        window.sessionStorage.setItem('cleffy:stale-chunk-reload-at', String(Date.now() - 2_000));
        renderMenu(modules);
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        // The prefetch fails first, on its own...
        fireEvent.pointerEnter(standIn);
        await act(async () => imports[0]?.reject(missingChunk()));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        // ...then the press imports the chunk again, and that fails too.
        fireEvent.click(standIn);
        expect(imports).toHaveLength(2);
        await act(async () => imports[1]?.reject(missingChunk()));
        expect(await screen.findByRole('alert')).toHaveTextContent('This menu couldn’t open');
        expect(staleChunk.isStaleChunkReloadPending()).toBe(false);
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();

        // Pressing again tries again; this time the chunk is there.
        fireEvent.pointerDown(standIn, { button: 0 });
        fireEvent.click(standIn);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(imports).toHaveLength(3);
        await act(async () => imports[2]?.resolve());
        expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    });

    it('says so offline, and takes back a controlled menu’s open', async () => {
        const { Menu, MenuItem, imports } = await deferredModules();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const onOpenChange = vi.fn();
        render(
            <Menu
                label="Account"
                triggerClassName="trigger"
                triggerContent="MH"
                open={false}
                onOpenChange={onOpenChange}
            >
                <MenuItem>Settings</MenuItem>
            </Menu>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Account' }));
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        await act(async () => imports[0]?.reject(missingChunk()));
        expect(await screen.findByRole('alert')).toHaveTextContent('You’re offline');
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
        // A library row's trigger near the bottom-right corner: the notice flips above it.
        ['flips above a trigger at the bottom of the screen', { top: 720, bottom: 752 }, 768, 656],
        // A screen too short for it either way: kept inside the gutter.
        ['stays on a screen too short for it below or above', { top: 40, bottom: 72 }, 120, 44],
        // Room below: under the trigger, where the menu would have opened.
        ['sits under a trigger with room below', { top: 100, bottom: 132 }, 768, 136],
    ])('%s', async (_name, { top, bottom }, innerHeight, expectedTop) => {
        const modules = await deferredModules();
        const { imports } = modules;
        window.sessionStorage.setItem('cleffy:stale-chunk-reload-at', String(Date.now() - 2_000));
        vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
        vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
        const noticeHeight = 60;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this.getAttribute('role') === 'alert'
                ? new DOMRect(0, 0, 240, noticeHeight)
                : new DOMRect(1000, top, 24, bottom - top);
        });
        renderMenu(modules);
        fireEvent.click(screen.getByRole('button', { name: 'Score actions' }));
        await act(async () => imports[0]?.reject(missingChunk()));
        const notice = await screen.findByRole('alert');
        expect(notice.style.top).toBe(`${expectedTop}px`);
        // Its end edge would be on the trigger's (1024), but it keeps the 16px gutter.
        expect(notice.style.left).toBe(`${1024 - 16 - 240}px`);
    });
});

describe('Menu, opened from the keyboard before its chunk is in', () => {
    const focusedItem = () => document.activeElement?.textContent;

    const renderMenu = async () => {
        const { Menu, MenuItem, imports } = await deferredModules();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
                <MenuItem>Duplicate</MenuItem>
                <MenuItem>Delete</MenuItem>
            </Menu>,
        );
        const standIn = screen.getByRole('button', { name: 'Score actions' });
        act(() => standIn.focus());
        return { standIn, imports };
    };

    it.each([
        ['ArrowDown', '{ArrowDown}', 'Rename'],
        ['ArrowUp', '{ArrowUp}', 'Delete'],
        ['Enter', '{Enter}', 'Rename'],
        ['Space', ' ', 'Rename'],
    ])('opens on %s, landing where Base UI does', async (_name, keys, item) => {
        const user = userEvent.setup();
        const { standIn, imports } = await renderMenu();
        await user.keyboard(keys);
        // Still loading: nothing yet, and the stand-in still has focus.
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(document.activeElement).toBe(standIn);
        await act(async () => imports[0]?.resolve());
        expect(await screen.findByRole('menu')).toBeInTheDocument();
        await waitFor(() => expect(focusedItem()).toBe(item));
        expect(document.activeElement).toHaveAttribute('role', 'menuitem');
        // Escape closes it onto the real trigger, as any keyboard open does.
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Score actions' }));
        expect(document.activeElement).not.toBe(standIn);
    });

    it.each([
        ['{ArrowDown}', 'Rename'],
        ['{ArrowUp}', 'Delete'],
        ['{Enter}', 'Rename'],
        [' ', 'Rename'],
    ])('lands as an already-loaded menu does on %s', async (keys, item) => {
        const user = userEvent.setup();
        const { Menu, MenuItem } = await coldModules();
        const { menuBaseModule } = await import('@/ui/lazyPrimitives');
        await menuBaseModule.load();
        render(
            <Menu label="Score actions" triggerClassName="trigger" triggerContent="⋮">
                <MenuItem>Rename</MenuItem>
                <MenuItem>Duplicate</MenuItem>
                <MenuItem>Delete</MenuItem>
            </Menu>,
        );
        act(() => screen.getByRole('button', { name: 'Score actions' }).focus());
        await user.keyboard(keys);
        await waitFor(() => expect(focusedItem()).toBe(item));
    });

    it.each([
        ['Space', 'Space'],
        ['Enter', 'Enter'],
    ])('opens on %s when the chunk comes in while the key is still down', async (_name, code) => {
        const user = userEvent.setup();
        const { standIn, imports } = await renderMenu();
        await user.keyboard(`[${code}>]`);
        // The import resolves before the key comes up: the stand-in is swapped out
        // mid-key, and the menu opens on the key it got, not on a click to come.
        await act(async () => imports[0]?.resolve());
        expect(await screen.findByRole('menu')).toBeInTheDocument();
        await waitFor(() => expect(focusedItem()).toBe('Rename'));
        expect(screen.getByRole('button', { name: 'Score actions' })).not.toBe(standIn);
        // Letting go neither closes it nor picks the item it landed on.
        await user.keyboard(`[/${code}]`);
        expect(screen.getByRole('menu')).toBeInTheDocument();
        expect(focusedItem()).toBe('Rename');
    });

    it('asks a controlled menu to open on an early ArrowDown, once the chunk is in', async () => {
        const user = userEvent.setup();
        const { Menu, MenuItem, imports } = await deferredModules();
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
                    <MenuItem>Sign out</MenuItem>
                </Menu>
            );
        };
        render(<Controlled />);
        act(() => screen.getByRole('button', { name: 'Account' }).focus());
        await user.keyboard('{ArrowDown}');
        expect(onOpenChange).not.toHaveBeenCalled();
        await act(async () => imports[0]?.resolve());
        await waitFor(() => expect(focusedItem()).toBe('Settings'));
        expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('opens a pointer press as before, without moving to an item', async () => {
        const { standIn, imports } = await renderMenu();
        fireEvent.pointerDown(standIn, { button: 0 });
        fireEvent.pointerUp(standIn, { button: 0 });
        fireEvent.click(standIn, { detail: 1 });
        await act(async () => imports[0]?.resolve());
        expect(await screen.findByRole('menu')).toBeInTheDocument();
        expect(document.activeElement).not.toHaveAttribute('role', 'menuitem');
    });
});
