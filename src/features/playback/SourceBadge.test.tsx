import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnalysisSource } from '@/features/playback/analysisSource';
import { SourceBadge } from '@/features/playback/SourceBadge';

const base = (over: Partial<AnalysisSource> & Pick<AnalysisSource, 'band' | 'reason' | 'tier'>): AnalysisSource => ({
    ...over,
});

afterEach(cleanup);

describe('SourceBadge', () => {
    it('renders Symbolic + source + integer confidence on accept', () => {
        render(
            <SourceBadge
                source={base({
                    tier: 'symbolic',
                    band: 'accept',
                    reason: 'accept',
                    sourceName: 'Mutopia',
                    matchScore: 100,
                })}
            />,
        );
        expect(screen.getByTestId('source-badge')).toHaveTextContent('Symbolic · Mutopia 100');
    });

    it('renders Pick edition on ambiguous', () => {
        render(
            <SourceBadge
                source={base({
                    tier: 'omr',
                    band: 'ambiguous',
                    reason: 'ambiguous',
                    matchScore: 81,
                })}
            />,
        );
        expect(screen.getByTestId('source-badge')).toHaveTextContent('Pick edition');
    });

    it('renders OMR on reject', () => {
        render(
            <SourceBadge
                source={base({
                    tier: 'omr',
                    band: 'reject',
                    reason: 'no_candidate',
                })}
            />,
        );
        expect(screen.getByTestId('source-badge')).toHaveTextContent('OMR');
    });

    it('credits the library in the tooltip on a corpus hit, without a new badge state', () => {
        const source = base({
            tier: 'symbolic',
            band: 'accept',
            reason: 'accept',
            sourceName: 'Mutopia',
            matchScore: 100,
        });
        const { unmount } = render(<SourceBadge source={source} corpusHit="hash" />);
        expect(screen.getByTestId('source-badge')).toHaveTextContent('Symbolic · Mutopia 100');
        expect(screen.getByTestId('source-badge')).toHaveAttribute(
            'title',
            'Playing from Mutopia (match 100) · From library (precomputed)',
        );
        unmount();

        render(<SourceBadge source={source} />);
        expect(screen.getByTestId('source-badge')).toHaveAttribute('title', 'Playing from Mutopia (match 100)');
    });
});
