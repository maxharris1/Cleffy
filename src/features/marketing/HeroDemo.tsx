import { TryLink } from '@/features/marketing/landingLinks';
import { ScoreInk } from '@/features/marketing/ScoreInk';
import { useHandwritingReady } from '@/features/marketing/useHandwritingReady';
import { useInViewOnce } from '@/features/marketing/useInViewOnce';

const PEN_PATH = 'M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z';

/** Static toolbar hint, pattern-copied from the real viewer toolbar: the pen, and its colours. */
const ToolbarHint = () => (
    <span
        aria-hidden="true"
        className="flex items-center gap-1.5 sm:rounded-[14px] sm:border sm:border-stone-200 sm:bg-white sm:px-2.5 sm:py-[5px]"
    >
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-accent-soft text-accent sm:h-[30px] sm:w-[30px]">
            <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 sm:h-4 sm:w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
            >
                <path strokeLinecap="round" strokeLinejoin="round" d={PEN_PATH} />
            </svg>
        </span>
        <span className="mx-1 hidden h-4 w-px bg-stone-200 sm:block" />
        <span className="hidden h-3.5 w-3.5 rounded-full sm:block" style={{ backgroundColor: '#1f2937' }} />
        <span
            className="ml-1 h-3 w-3 rounded-full sm:mx-1 sm:h-3.5 sm:w-3.5 sm:ring-2 sm:ring-accent sm:ring-offset-2"
            style={{ backgroundColor: '#dc2626' }}
        />
        <span className="h-3 w-3 rounded-full sm:h-3.5 sm:w-3.5" style={{ backgroundColor: '#2563eb' }} />
    </span>
);

/**
 * The hero's score: the opening of Für Elise marking itself up, Ms. Davis in
 * red and Leo in blue. The whole card is one link into the /try demo (the
 * line under the score sits inside it, so there are no nested links). The
 * marks wait for the card to scroll into view and for the handwriting face.
 * No viewer code is imported here: the demo's chunks are only fetched when a
 * visitor reaches for the link (landingLinks.tsx).
 */
export const HeroDemo = () => {
    const { ref, inView } = useInViewOnce<HTMLDivElement>(0.2);
    const handwritingReady = useHandwritingReady();
    return (
        <TryLink
            aria-label="Open the live Für Elise demo"
            className="ink-score-card block overflow-hidden rounded-xl bg-white text-ink no-underline sm:rounded-[14px]"
        >
            <div ref={ref} className={`mx-3.5 mt-3.5 sm:mx-7 sm:mt-7${inView && handwritingReady ? ' is-inview' : ''}`}>
                <ScoreInk alt="The opening of Für Elise, marked up live by a teacher and a student" size="hero" chips />
            </div>
            <span className="flex items-center justify-between gap-2.5 border-t border-ink/7 px-3.5 pb-2.5 pt-2 sm:gap-3 sm:px-5 sm:pb-4 sm:pt-3.5">
                <ToolbarHint />
                <span className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline decoration-accent/40 underline-offset-2 sm:text-[15px]">
                    <span className="pointer-coarse:hidden">Click the score to draw on it</span>
                    <span className="hidden pointer-coarse:inline">Tap the score to draw on it</span>
                </span>
            </span>
        </TryLink>
    );
};
