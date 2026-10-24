import { readFileSync } from 'node:fs';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast, toasterModule } from '@/ui/toast';
import { ToastHost } from '@/ui/ToastHost';

const mockMatchMedia = (phone: boolean) => {
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: phone && query.includes('max-width'),
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        })),
    );
};

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

// Sonner's store is module state shared by every test here, so each test uses
// messages of its own rather than relying on a clean stack.
describe('toast', () => {
    it('shows a toast fired before its chunk had arrived, in a stack portalled to <body>', async () => {
        render(<ToastHost />);
        toast.saved('Score saved', { description: 'Sonata in C' });

        const title = await screen.findByText('Score saved');
        expect(screen.getByText('Sonata in C')).toBeInTheDocument();
        // Beside #root, not inside the render container: a dialog's inert pass
        // over the app must not reach the stack.
        const region = title.closest('section');
        expect(region?.parentElement).toBe(document.body);
        expect(region).toHaveAttribute('aria-live', 'polite');
    });

    it('marks success and error toasts by type, without rich colours', async () => {
        render(<ToastHost />);
        toast.success('Assigned to Maya');
        toast.error('Could not delete the score.');

        const success = (await screen.findByText('Assigned to Maya')).closest('[data-sonner-toast]');
        const error = (await screen.findByText('Could not delete the score.')).closest('[data-sonner-toast]');
        expect(success).toHaveAttribute('data-type', 'success');
        expect(error).toHaveAttribute('data-type', 'error');
        expect(error).not.toHaveAttribute('data-rich-colors', 'true');
    });

    it('defaults the saved and shared wording', async () => {
        render(<ToastHost />);
        toast.saved();
        toast.shared();
        expect(await screen.findByText('Saved')).toBeInTheDocument();
        expect(await screen.findByText('Shared')).toBeInTheDocument();
    });

    it('follows a promise and hands the same promise back', async () => {
        render(<ToastHost />);
        const work = Promise.resolve(3);
        const returned = toast.promise(work, {
            loading: 'Importing…',
            success: (n) => `Imported ${n} pages`,
            error: 'Import failed',
        });
        expect(returned).toBe(work);
        expect(await screen.findByText('Imported 3 pages')).toBeInTheDocument();
    });

    it('sits bottom-centre from sm up, and drops from the top on a phone', async () => {
        await toasterModule.load();
        mockMatchMedia(false);
        const { unmount } = render(<ToastHost />);
        toast.success('Wide toast');
        await screen.findByText('Wide toast');
        expect(document.querySelector('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'bottom');
        expect(document.querySelector('[data-sonner-toaster]')).toHaveAttribute('data-x-position', 'center');
        unmount();

        mockMatchMedia(true);
        render(<ToastHost />);
        toast.success('Phone toast');
        await screen.findByText('Phone toast');
        await waitFor(() =>
            expect(document.querySelector('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'top'),
        );
    });

    it('renders nothing until the chunk is in', () => {
        const get = vi.spyOn(toasterModule, 'get').mockReturnValue(null);
        const { container } = render(<ToastHost />);
        expect(container).toBeEmptyDOMElement();
        get.mockRestore();
    });

    it('keeps the fade and drops the travel under reduced motion', () => {
        const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');
        const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
        // Sonner's own reduced-motion rule is `transition: none !important` on
        // [data-sonner-toast]; this one is more specific, so it wins.
        expect(reduced).toMatch(
            /\[data-sonner-toaster\] \[data-sonner-toast\] \{\s*transition: opacity 200ms ease !important;/,
        );
    });
});
