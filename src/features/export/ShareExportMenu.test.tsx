import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShareExportMenu } from '@/features/export/ShareExportMenu';

vi.mock('@/features/export/exportPageImage', () => ({
    exportAnnotatedPageImage: vi.fn(),
}));

vi.mock('@/features/export/exportPdf', () => ({
    exportAnnotatedPdf: vi.fn(),
}));

vi.mock('@/sync/db', () => ({
    getDb: () => ({
        pdfCache: {
            get: vi.fn().mockResolvedValue(undefined),
        },
    }),
}));

afterEach(cleanup);

describe('ShareExportMenu', () => {
    it('uses Export for the visible label and aria-label', () => {
        render(<ShareExportMenu docId="d1" title="Für Elise" />);
        const button = screen.getByRole('button', { name: 'Export' });
        expect(button).toHaveTextContent('Export');
        expect(button).toHaveAttribute('aria-label', 'Export');
    });

    it('shows mapped copy when the score is not cached', async () => {
        render(<ShareExportMenu docId="d1" title="Für Elise" />);
        await userEvent.click(screen.getByRole('button', { name: 'Export' }));
        await userEvent.click(screen.getByRole('menuitem', { name: /export whole score as pdf/i }));
        expect(
            await screen.findByText('This score is not ready to export yet. Wait a moment and try again.'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/not cached on this device/i)).toBeNull();
    });
});
