import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnalysisSource } from '@/features/playback/analysisSource';
import { attributionOf, parseAnalysisSource, sourceBadgeTitle } from '@/features/playback/analysisSource';
import { SourceAttribution } from '@/features/playback/SourceAttribution';

const source = (over: Partial<AnalysisSource> = {}): AnalysisSource => ({
    tier: 'omr',
    band: 'reject',
    reason: 'no_candidate',
    ...over,
});

afterEach(cleanup);

describe('attributionOf', () => {
    it('is owed for CC-BY and CC-BY-SA', () => {
        expect(attributionOf(source({ licence: 'CC-BY-SA', editorCredit: 'Chris Sawer (Mutopia)' }))).toEqual({
            credit: 'Chris Sawer (Mutopia)',
            licence: 'CC-BY-SA',
            url: null,
        });
        expect(attributionOf(source({ licence: 'CC-BY' }))?.licence).toBe('CC-BY');
    });

    it('is not owed for public domain, CC0, or an analysis with no licence', () => {
        expect(attributionOf(source({ licence: 'PD', editorCredit: 'Someone' }))).toBeNull();
        expect(attributionOf(source({ licence: 'CC0', editorCredit: 'Someone' }))).toBeNull();
        expect(attributionOf(source())).toBeNull();
    });
});

describe('parseAnalysisSource provenance', () => {
    it('keeps licence, editor credit and source url off timings.source', () => {
        expect(
            parseAnalysisSource({
                tier: 'symbolic',
                band: 'accept',
                reason: 'accept',
                licence: 'CC-BY-SA',
                editorCredit: '  Chris Sawer (Mutopia)  ',
                sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
            }),
        ).toMatchObject({
            licence: 'CC-BY-SA',
            editorCredit: 'Chris Sawer (Mutopia)',
            sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
        });
    });

    it('drops an unknown licence and blank strings rather than rendering them', () => {
        const parsed = parseAnalysisSource({
            tier: 'omr',
            band: 'reject',
            reason: 'no_candidate',
            licence: 'WTFPL',
            editorCredit: '   ',
            sourceUrl: '',
        });
        expect(parsed).toBeDefined();
        expect(parsed).not.toHaveProperty('licence');
        expect(parsed).not.toHaveProperty('editorCredit');
        expect(parsed).not.toHaveProperty('sourceUrl');
    });
});

describe('sourceBadgeTitle', () => {
    it('appends the credit and licence when one is owed', () => {
        expect(
            sourceBadgeTitle(
                source({
                    tier: 'symbolic',
                    band: 'accept',
                    reason: 'accept',
                    sourceName: 'Mutopia',
                    matchScore: 100,
                    licence: 'CC-BY-SA',
                    editorCredit: 'Chris Sawer (Mutopia)',
                }),
            ),
        ).toBe('Playing from Mutopia (match 100) — edition by Chris Sawer (Mutopia), licensed CC-BY-SA');
    });

    it('is unchanged for a public-domain edition', () => {
        expect(sourceBadgeTitle(source({ licence: 'PD' }))).toBe('No matching MusicXML');
    });
});

describe('SourceAttribution', () => {
    it('names the editor, the licence and links the source', () => {
        render(
            <SourceAttribution
                source={source({
                    licence: 'CC-BY-SA',
                    editorCredit: 'Chris Sawer, after Breitkopf & Härtel (Mutopia)',
                    sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
                })}
            />,
        );
        expect(screen.getByTestId('source-attribution')).toHaveTextContent(
            'Edition by Chris Sawer, after Breitkopf & Härtel (Mutopia) · CC-BY-SA',
        );
        expect(screen.getByRole('link', { name: 'source' })).toHaveAttribute(
            'href',
            'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
        );
    });

    it('still names the licence when the credit is missing', () => {
        render(<SourceAttribution source={source({ licence: 'CC-BY' })} />);
        expect(screen.getByTestId('source-attribution')).toHaveTextContent('Edition by Unnamed editor · CC-BY');
    });

    it('renders nothing for a public-domain edition', () => {
        render(<SourceAttribution source={source({ licence: 'PD', editorCredit: 'Someone' })} />);
        expect(screen.queryByTestId('source-attribution')).toBeNull();
    });
});
