import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProgressBar } from '@/ui/ProgressBar';

afterEach(cleanup);

describe('ProgressBar', () => {
    it('fades out once done, on opacity alone', () => {
        const { rerender } = render(<ProgressBar value={100} label="Uploading score" />);
        const bar = screen.getByRole('progressbar', { name: 'Uploading score' });
        expect(bar).not.toHaveAttribute('data-done');
        expect(bar).toHaveClass('transition-opacity', 'data-done:opacity-0');

        rerender(<ProgressBar value={100} label="Uploading score" done />);
        expect(bar).toHaveAttribute('data-done');
    });

    it('slides the fill by transform, and jumps under reduced motion', () => {
        render(<ProgressBar value={40} label="Uploading score" />);
        const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
        expect(fill.style.transform).toBe('translateX(-60%)');
        expect(fill).toHaveClass('transition-transform', 'motion-reduce:transition-none');
    });

    it('turns an indeterminate sweep into a full determinate bar', () => {
        const { rerender } = render(<ProgressBar indeterminate value={100} label="Importing from IMSLP" />);
        expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
        rerender(<ProgressBar value={100} label="Importing from IMSLP" />);
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });
});
