import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LinkUrl } from '@/features/share/LinkUrl';

afterEach(cleanup);

const URL = 'https://cleffy.io/join/7f3a9c2e4b1d48e6a0f5c3b2';

describe('LinkUrl', () => {
    it('renders the whole URL and keeps the last 8 characters out of the truncating part', () => {
        const { container } = render(<LinkUrl url={URL} />);
        expect(container).toHaveTextContent(URL);

        const tail = screen.getByText('a0f5c3b2');
        expect(tail).toHaveClass('shrink-0');
        expect(tail).not.toHaveClass('truncate');
        expect(screen.getByText('https://cleffy.io/join/7f3a9c2e4b1d48e6')).toHaveClass('truncate');
    });
});
