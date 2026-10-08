import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ScoreSourceButton } from '@/features/viewer/ScoreSourceButton';
import { requiresAttribution } from '@/features/viewer/scoreSource';

afterEach(() => {
    cleanup();
});

const ccTypeset = {
    source_url: 'https://imslp.org/wiki/Piano_Sonata_No.14%2C_Op.27_No.2_(Beethoven%2C_Ludwig_van)',
    source_filename: 'PMLP1458-Beethoven Klavier-Mondscheinsonate-Op27Nr2.pdf',
    source_license: 'Creative Commons Attribution-ShareAlike 4.0',
    source_attribution: {
        source: 'imslp' as const,
        work: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
        composer: 'Beethoven, Ludwig van',
        editor: 'Viktor Keil',
        arranger: null,
        publisher: 'Viktor Keil, 2024',
        year: null,
    },
};

describe('ScoreSourceButton', () => {
    it('renders nothing for an uploaded score with no recorded source', () => {
        const { container } = render(
            <ScoreSourceButton
                doc={{ source_url: null, source_filename: null, source_license: null, source_attribution: null }}
            />,
        );
        expect(container).toBeEmptyDOMElement();
        // A row from the library list carries no provenance fields at all.
        const { container: bare } = render(<ScoreSourceButton doc={{}} />);
        expect(bare).toBeEmptyDOMElement();
    });

    it('shows the IMSLP source, license and credits, with the attribution reminder for CC-BY', async () => {
        render(<ScoreSourceButton doc={ccTypeset} />);
        await userEvent.click(screen.getByRole('button', { name: 'Source' }));

        const dialog = screen.getByRole('dialog', { name: 'About this score' });
        expect(within(dialog).getByText('Imported from IMSLP, the Petrucci Music Library.')).toBeInTheDocument();
        expect(within(dialog).getByText('Beethoven, Ludwig van')).toBeInTheDocument();
        expect(within(dialog).getByText('Viktor Keil')).toBeInTheDocument();
        expect(within(dialog).getByText('Viktor Keil, 2024')).toBeInTheDocument();
        expect(within(dialog).getByText('Creative Commons Attribution-ShareAlike 4.0')).toBeInTheDocument();
        expect(within(dialog).getByText(/requires attribution/)).toBeInTheDocument();
        const link = within(dialog).getByRole('link', { name: 'View on IMSLP' });
        expect(link).toHaveAttribute('href', ccTypeset.source_url);
        expect(link).toHaveAttribute('rel', 'noreferrer');
        expect(within(dialog).queryByText('Arranger')).not.toBeInTheDocument();
    });

    it('omits the attribution reminder for public domain and CC0, and joins publisher with year', async () => {
        render(
            <ScoreSourceButton
                doc={{
                    ...ccTypeset,
                    source_license: 'Public Domain',
                    source_attribution: { ...ccTypeset.source_attribution, publisher: 'Diabelli', year: 1802 },
                }}
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Source' }));
        const dialog = screen.getByRole('dialog', { name: 'About this score' });
        expect(within(dialog).getByText('Diabelli, 1802')).toBeInTheDocument();
        expect(within(dialog).queryByText(/requires attribution/)).not.toBeInTheDocument();
    });

    it('never links a non-https source', async () => {
        render(<ScoreSourceButton doc={{ ...ccTypeset, source_url: 'javascript:alert(1)' }} />);
        await userEvent.click(screen.getByRole('button', { name: 'Source' }));
        expect(screen.queryByRole('link', { name: 'View on IMSLP' })).not.toBeInTheDocument();
    });
});

describe('requiresAttribution', () => {
    it('is true for CC BY variants, false for CC0, public domain and unknown', () => {
        expect(requiresAttribution('Creative Commons Attribution 4.0')).toBe(true);
        expect(requiresAttribution('Creative Commons Attribution-NonCommercial-ShareAlike 4.0')).toBe(true);
        expect(requiresAttribution('Creative Commons Zero 1.0')).toBe(false);
        expect(requiresAttribution('Public Domain')).toBe(false);
        expect(requiresAttribution(null)).toBe(false);
    });
});
