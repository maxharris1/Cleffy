import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScoreThumb } from '@/features/library/ScoreThumb';

const getThumbnail = vi.hoisted(() => vi.fn());
vi.mock('@/features/library/thumbnailService', () => ({ getThumbnail }));

const createObjectURL = vi.fn(() => 'blob:thumb-1');
const revokeObjectURL = vi.fn();

beforeEach(() => {
    getThumbnail.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    // jsdom implements neither.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
});

afterEach(() => {
    cleanup();
});

describe('ScoreThumb', () => {
    it('draws a staff placeholder when there is no render for this score', async () => {
        getThumbnail.mockResolvedValue(null);
        const { container } = render(<ScoreThumb docId="d1" contentRev={0} />);

        await waitFor(() => expect(getThumbnail).toHaveBeenCalledWith('d1', 0));
        expect(container.querySelector('svg')).not.toBeNull();
        expect(container.querySelector('img')).toBeNull();
    });

    it('swaps in the rendered first page once it resolves', async () => {
        getThumbnail.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
        const { container } = render(<ScoreThumb docId="d1" contentRev={2} />);

        await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
        expect(container.querySelector('img')).toHaveAttribute('src', 'blob:thumb-1');
        expect(container.querySelector('svg')).toBeNull();
    });

    it('revokes the object URL on unmount so the blob can be collected', async () => {
        getThumbnail.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
        const { container, unmount } = render(<ScoreThumb docId="d1" contentRev={0} />);

        await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
        unmount();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
    });
});
