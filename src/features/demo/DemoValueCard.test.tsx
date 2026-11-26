import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DemoValueCard } from '@/features/demo/DemoValueCard';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('DemoValueCard over the viewer’s phone controls', () => {
    it('publishes its height as --viewer-bottom-dock while shown, and clears it once gone', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            top: 0,
            bottom: 180,
            height: 180,
        } as DOMRect);
        const dock = () => document.documentElement.style.getPropertyValue('--viewer-bottom-dock');

        const { unmount } = render(
            <MemoryRouter>
                <DemoValueCard signUpTo="/signup" onSignUp={() => {}} onDismiss={() => {}} />
            </MemoryRouter>,
        );
        expect(dock()).toBe('180px');

        unmount();
        expect(dock()).toBe('');
    });
});
