import type { AnalysisSource } from '@/features/playback/analysisSource';
import { attributionOf } from '@/features/playback/analysisSource';

/**
 * Credit line for a CC-BY / CC-BY-SA edition.
 *
 * The play-along corpus fetches editions from Mutopia, OpenScore and the
 * Internet Archive, and the share-alike ones oblige us to name the editor and
 * the licence wherever we serve them. Public-domain and CC0 editions carry no
 * such condition and render nothing.
 */
export const SourceAttribution = ({ source }: { source: AnalysisSource }) => {
    const attribution = attributionOf(source);
    if (!attribution) {
        return null;
    }
    const who = attribution.credit ?? 'Unnamed editor';
    return (
        <p className="text-center text-[11px] leading-tight text-stone-500" data-testid="source-attribution">
            Edition by {who} · {attribution.licence}
            {attribution.url ? (
                <>
                    {' · '}
                    <a
                        href={attribution.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-stone-300 hover:decoration-stone-500"
                    >
                        source
                    </a>
                </>
            ) : null}
        </p>
    );
};
