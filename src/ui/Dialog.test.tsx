import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from '@/ui/Dialog';

afterEach(() => {
    cleanup();
});

describe('Dialog', () => {
    it('renders an aria-modal dialog with a visible title and closes on Escape', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Share this score" onClose={onClose}>
                <button type="button">Inside</button>
            </Dialog>,
        );
        const dialog = await screen.findByRole('dialog', { name: 'Share this score' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('heading', { name: 'Share this score' })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('moves focus into the dialog on mount and restores it on unmount', async () => {
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        const { unmount } = render(
            <Dialog label="Confirm" onClose={() => {}}>
                <p>Body</p>
            </Dialog>,
        );
        // Base UI moves focus in once the popup has mounted.
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Confirm' })));
        unmount();
        await waitFor(() => expect(document.activeElement).toBe(outside));
        outside.remove();
    });

    it('closes on scrim click but not on panel click', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Share this score" onClose={onClose}>
                <p>Body</p>
            </Dialog>,
        );
        const dialog = await screen.findByRole('dialog', { name: 'Share this score' });
        await user.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        const scrim = dialog.parentElement;
        expect(scrim).not.toBeNull();
        await user.click(scrim as HTMLElement);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open when a press starts in the panel and ends on the scrim (a text selection dragged out)', async () => {
        const onClose = vi.fn();
        render(
            <Dialog label="Rename score" onClose={onClose}>
                <input aria-label="Title" defaultValue="Clementi" />
            </Dialog>,
        );
        const field = await screen.findByRole('textbox', { name: 'Title' });
        const scrim = screen.getByRole('dialog', { name: 'Rename score' }).parentElement as HTMLElement;
        // The browser targets click at the nearest common ancestor of the press
        // and the release — the scrim, when the drag ended outside the panel.
        fireEvent.pointerDown(field);
        fireEvent.pointerUp(scrim);
        fireEvent.click(scrim);
        expect(onClose).not.toHaveBeenCalled();

        // And the other way round: pressed on the scrim, released in the panel.
        fireEvent.pointerDown(scrim);
        fireEvent.click(field);
        expect(onClose).not.toHaveBeenCalled();

        // Press and release on the scrim: that is a dismissal.
        fireEvent.pointerDown(scrim);
        fireEvent.click(scrim);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes only the top dialog on Escape', async () => {
        const user = userEvent.setup();
        const onCloseBottom = vi.fn();
        const onCloseTop = vi.fn();
        render(
            <>
                <Dialog label="Share" onClose={onCloseBottom}>
                    <p>Bottom</p>
                </Dialog>
                <Dialog label="Remove access?" onClose={onCloseTop}>
                    <p>Top</p>
                </Dialog>
            </>,
        );
        await screen.findByText('Top');
        await user.keyboard('{Escape}');
        expect(onCloseTop).toHaveBeenCalledTimes(1);
        expect(onCloseBottom).not.toHaveBeenCalled();
    });

    it('renders an alertdialog the scrim cannot dismiss', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Delete score?" onClose={onClose} alert>
                <p>Body</p>
            </Dialog>,
        );
        const dialog = await screen.findByRole('alertdialog', { name: 'Delete score?' });
        await user.click(dialog.parentElement as HTMLElement);
        expect(onClose).not.toHaveBeenCalled();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes a phone sheet dragged down by its grab bar, and springs back from a short drag', async () => {
        const onClose = vi.fn();
        render(
            <Dialog label="Lesson history" onClose={onClose} sheet>
                <p>Body</p>
            </Dialog>,
        );
        await screen.findByRole('dialog', { name: 'Lesson history' });
        const grabber = document.querySelector('[data-sheet-grabber]') as HTMLElement;
        expect(grabber).not.toBeNull();

        fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 100 });
        fireEvent.pointerMove(grabber, { pointerId: 1, clientY: 118 });
        fireEvent.pointerUp(grabber, { pointerId: 1, clientY: 118 });
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.pointerDown(grabber, { pointerId: 2, button: 0, clientY: 100 });
        fireEvent.pointerMove(grabber, { pointerId: 2, clientY: 260 });
        fireEvent.pointerUp(grabber, { pointerId: 2, clientY: 260 });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('springs a short drag back on the drawer curve, and jumps back under reduced motion', async () => {
        const reduce = { current: false };
        vi.stubGlobal(
            'matchMedia',
            vi.fn((query: string) => ({ matches: reduce.current && query.includes('reduce'), media: query })),
        );
        render(
            <Dialog label="Lesson history" onClose={vi.fn()} sheet>
                <p>Body</p>
            </Dialog>,
        );
        const dialog = await screen.findByRole('dialog', { name: 'Lesson history' });
        const grabber = document.querySelector('[data-sheet-grabber]') as HTMLElement;
        const drag = (pointerId: number) => {
            fireEvent.pointerDown(grabber, { pointerId, button: 0, clientY: 100 });
            fireEvent.pointerMove(grabber, { pointerId, clientY: 118 });
            fireEvent.pointerUp(grabber, { pointerId, clientY: 118 });
        };
        // The sheet's own panel carries the drag offset.
        const sheet = () =>
            [dialog, ...dialog.querySelectorAll<HTMLElement>('*')].find((el) => el.style.transition !== '') ?? dialog;

        drag(1);
        expect(sheet().style.transition).toBe('transform var(--duration-enter) var(--ease-drawer)');
        expect(sheet().style.transform).toBe('');

        reduce.current = true;
        drag(2);
        expect(sheet().style.transition).toBe('none');
        expect(sheet().style.transform).toBe('');
        vi.unstubAllGlobals();
    });
});

describe('Dialog, lazily loaded', () => {
    /** Fresh copies of the modules, so the panel's chunk has not been loaded yet. */
    const coldModules = async () => {
        vi.resetModules();
        const [{ Dialog: ColdDialog }, { isDialogOpen }, { dialogPanelModule }] = await Promise.all([
            import('@/ui/Dialog'),
            import('@/ui/dialogStack'),
            import('@/ui/lazyPrimitives'),
        ]);
        return { ColdDialog, isDialogOpen, dialogPanelModule };
    };

    it('takes its place on the dialog stack before its panel has loaded, and shows nothing until then', async () => {
        const { ColdDialog, isDialogOpen, dialogPanelModule } = await coldModules();
        expect(dialogPanelModule.get()).toBeNull();
        const { container, unmount } = render(
            <ColdDialog label="Share this score" onClose={() => {}}>
                <p>Body</p>
            </ColdDialog>,
        );
        // Mounted, and already counted as open: the viewer's keys stand down now.
        expect(isDialogOpen()).toBe(true);
        // The Suspense fallback is nothing at all — no placeholder to flash.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(container).toBeEmptyDOMElement();
        expect(document.body.querySelector('[data-base-ui-portal]')).toBeNull();

        expect(await screen.findByRole('dialog', { name: 'Share this score' })).toBeInTheDocument();
        expect(dialogPanelModule.get()).not.toBeNull();
        unmount();
        expect(isDialogOpen()).toBe(false);
    });

    it('moves focus in and returns it to the opener on a first, lazy open', async () => {
        const { ColdDialog } = await coldModules();
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const { unmount } = render(
            <ColdDialog label="Confirm" onClose={() => {}}>
                <p>Body</p>
            </ColdDialog>,
        );
        const dialog = await screen.findByRole('dialog', { name: 'Confirm' });
        await waitFor(() => expect(document.activeElement).toBe(dialog));
        unmount();
        await waitFor(() => expect(document.activeElement).toBe(opener));
        opener.remove();
    });

    it('renders straight away, in the same commit, once the chunk has loaded', async () => {
        const { ColdDialog, dialogPanelModule } = await coldModules();
        await dialogPanelModule.load();
        render(
            <ColdDialog label="Delete score?" onClose={() => {}} alert>
                <p>Body</p>
            </ColdDialog>,
        );
        expect(screen.getByRole('alertdialog', { name: 'Delete score?' })).toBeInTheDocument();
    });
});

describe('Dialog, Escape while its panel is loading', () => {
    afterEach(() => {
        vi.doUnmock('@/ui/lazyPrimitives');
    });

    /** Fresh modules whose panel chunk arrives only when `arrive` is called. */
    const deferredModules = async () => {
        vi.resetModules();
        let arrive = () => {};
        const gate = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        vi.doMock('@/ui/lazyPrimitives', async () => {
            const { lazyModule } = await import('@/ui/lazyModule');
            const panel = await import('@/ui/DialogPanel');
            return { dialogPanelModule: lazyModule(() => gate.then(() => panel)) };
        });
        // One at a time: the mock's factory is async, and two imports racing it would make two modules.
        const { dialogPanelModule } = await import('@/ui/lazyPrimitives');
        const { Dialog: ColdDialog } = await import('@/ui/Dialog');
        const { isDialogOpen } = await import('@/ui/dialogStack');
        return { ColdDialog, isDialogOpen, dialogPanelModule, arrive };
    };

    it.each([
        ['a dialog', false, 'dialog'],
        ['an alertdialog', true, 'alertdialog'],
    ] as const)('closes %s, which then never shows up', async (_name, alert, role) => {
        const { ColdDialog, isDialogOpen, dialogPanelModule, arrive } = await deferredModules();
        const onClose = vi.fn();
        const Opener = () => {
            const [open, setOpen] = useState(true);
            return open ? (
                <ColdDialog
                    label="Delete score?"
                    alert={alert}
                    onClose={() => {
                        onClose();
                        setOpen(false);
                    }}
                >
                    <p>Body</p>
                </ColdDialog>
            ) : null;
        };
        render(<Opener />);
        expect(isDialogOpen()).toBe(true);
        const windowKeys = vi.fn();
        window.addEventListener('keydown', windowKeys);
        await userEvent.keyboard('{Escape}');
        window.removeEventListener('keydown', windowKeys);
        expect(onClose).toHaveBeenCalledTimes(1);
        // The key stops at the dialog, as Base UI's Escape does.
        expect(windowKeys).not.toHaveBeenCalled();
        // Off the stack at once: the viewer's keys are live again.
        expect(isDialogOpen()).toBe(false);

        await act(async () => arrive());
        await waitFor(() => expect(dialogPanelModule.get()).not.toBeNull());
        expect(screen.queryByRole(role)).not.toBeInTheDocument();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes only the top dialog, and hands Escape to the panel once it is in', async () => {
        const { ColdDialog, arrive } = await deferredModules();
        const onCloseBelow = vi.fn();
        const onCloseTop = vi.fn();
        const Stack = () => {
            const [top, setTop] = useState(true);
            return (
                <>
                    <ColdDialog label="Share this score" onClose={onCloseBelow}>
                        <p>Below</p>
                    </ColdDialog>
                    {top ? (
                        <ColdDialog
                            label="Discard changes?"
                            alert
                            onClose={() => {
                                onCloseTop();
                                setTop(false);
                            }}
                        >
                            <p>Top</p>
                        </ColdDialog>
                    ) : null}
                </>
            );
        };
        render(<Stack />);
        await userEvent.keyboard('{Escape}');
        expect(onCloseTop).toHaveBeenCalledTimes(1);
        expect(onCloseBelow).not.toHaveBeenCalled();

        // The one left loads; from then on its panel handles Escape, once.
        await act(async () => arrive());
        expect(await screen.findByRole('dialog', { name: 'Share this score' })).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        await userEvent.keyboard('{Escape}');
        expect(onCloseBelow).toHaveBeenCalledTimes(1);
        expect(onCloseTop).toHaveBeenCalledTimes(1);
    });
});
