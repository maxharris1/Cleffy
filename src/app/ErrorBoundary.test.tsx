import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/app/ErrorBoundary';

const reportError = vi.fn();

vi.mock('@/lib/monitoring', () => ({
    reportError: (...args: unknown[]) => reportError(...args),
}));

const Boom = (): never => {
    throw new Error('render failed');
};

describe('ErrorBoundary', () => {
    afterEach(() => {
        reportError.mockClear();
        vi.restoreAllMocks();
    });

    it('reports a render crash with its component stack and shows the recovery screen', () => {
        // React logs the caught error itself; keep the test output readable.
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(
            <MemoryRouter>
                <ErrorBoundary>
                    <Boom />
                </ErrorBoundary>
            </MemoryRouter>,
        );

        expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
        expect(reportError).toHaveBeenCalledTimes(1);
        const [error, context] = reportError.mock.calls[0] as [Error, { componentStack?: string; tags?: object }];
        expect(error.message).toBe('render failed');
        expect(context.tags).toEqual({ source: 'error-boundary' });
        expect(context.componentStack).toContain('Boom');
    });

    it('reports nothing when the tree renders', () => {
        render(
            <MemoryRouter>
                <ErrorBoundary>
                    <p>fine</p>
                </ErrorBoundary>
            </MemoryRouter>,
        );
        expect(screen.getByText('fine')).toBeInTheDocument();
        expect(reportError).not.toHaveBeenCalled();
    });
});
