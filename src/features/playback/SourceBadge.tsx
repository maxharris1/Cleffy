import type { AnalysisSource } from '@/features/playback/analysisSource';
import { sourceBadgeText, sourceBadgeTitle } from '@/features/playback/analysisSource';

export const SourceBadge = ({ source }: { source: AnalysisSource }) => {
    const attention = source.band === 'ambiguous';
    const className = [
        'flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium',
        attention ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-stone-200 text-stone-600',
    ].join(' ');
    return (
        <span className={className} title={sourceBadgeTitle(source)} data-testid="source-badge">
            {sourceBadgeText(source)}
        </span>
    );
};
