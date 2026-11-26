import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Wordmark } from '@/ui/Wordmark';

afterEach(() => {
    cleanup();
});

describe('Wordmark', () => {
    it.each(['paper', 'ink'] as const)('reads as exactly "Cleffy" on %s with the rule hidden', (tone) => {
        const { container } = render(
            <a href="/library">
                <Wordmark tone={tone} />
            </a>,
        );
        expect(screen.getByRole('link', { name: 'Cleffy' })).toBeInTheDocument();
        expect(container.querySelector('[aria-hidden="true"]')).toBeEmptyDOMElement();
    });
});
