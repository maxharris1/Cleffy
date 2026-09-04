/**
 * Stand-in cover for a score with no rendered page image — the library shelf
 * uses it until a first page is cached on this device, and IMSLP search cards
 * use it always (IMSLP hits carry no image data).
 *
 * Set like an engraved edition title plate rather than left blank: warm paper,
 * a double hairline frame, the title over a small fleuron divider, a
 * publisher's lyre in the middle, and a line of engraved bars at the foot.
 * The bars are decoration, not the piece — their pattern is picked from the
 * title so neighbouring cards differ, the way no two plates off a press are
 * quite alike. Purely decorative — the enclosing cover is aria-hidden and the
 * card's own title already names the score.
 *
 * `className` sets the top padding: the library passes the default `pt-10` to
 * clear the favourite star pinned to the cover's top-right corner, while search
 * cards have no overlay controls and sit the type higher.
 */

/** Classical publisher's device — scrolled arms, five strings, pedestal. */
const Lyre = () => (
    <svg
        viewBox="0 0 60 74"
        className="h-auto max-h-full w-[3.25rem] text-ink/15"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <path d="M16 58 C7 46 5 28 10 14 C11.5 9.5 8 6 5 8" />
        <path d="M44 58 C53 46 55 28 50 14 C48.5 9.5 52 6 55 8" />
        <path d="M14 58 h32" />
        <path d="M20 14 v44 M25 12 v46 M30 11 v47 M35 12 v46 M40 14 v44" strokeWidth={0.9} />
        <path d="M24 64 h12 M21 70 h18" />
        <path d="M30 58 v12" strokeWidth={0.9} />
    </svg>
);

/**
 * Engraved note figures, one per plate. Coordinates live on a 150×36 staff
 * (lines y=6..30); stems are thin rects, beams are skewed rects.
 */
const BAR_FIGURES = [
    // Rising thirds settling on a phrase end.
    <g key="melody" fill="currentColor">
        <ellipse cx="14" cy="24" rx="3" ry="2.2" transform="rotate(-18 14 24)" />
        <rect x="16.4" y="8" width="1" height="15.6" />
        <ellipse cx="30" cy="18" rx="3" ry="2.2" transform="rotate(-18 30 18)" />
        <rect x="32.4" y="3" width="1" height="14.6" />
        <ellipse cx="46" cy="21" rx="3" ry="2.2" transform="rotate(-18 46 21)" />
        <rect x="48.4" y="5" width="1" height="15.6" />
        <rect x="32.4" y="3" width="17" height="2.4" />
        <ellipse cx="62" cy="15" rx="3" ry="2.2" transform="rotate(-18 62 15)" />
        <rect x="64.4" y="0" width="1" height="14.6" />
        <rect x="48.4" y="2.2" width="17" height="2.4" transform="skewY(-6)" />
        <ellipse cx="90" cy="18" rx="3.2" ry="2.4" transform="rotate(-18 90 18)" />
        <rect x="92.6" y="2.5" width="1" height="15" />
        <ellipse cx="112" cy="12" rx="3" ry="2.2" transform="rotate(-18 112 12)" />
        <rect x="114.4" y="-2" width="1" height="13.6" />
        <ellipse cx="128" cy="15" rx="3" ry="2.2" transform="rotate(-18 128 15)" />
        <rect x="130.4" y="0" width="1" height="14.6" />
        <rect x="114.4" y="-2" width="17" height="2.4" transform="skewY(4)" />
    </g>,
    // Rising arpeggio in beamed fours.
    <g key="arpeggio" fill="currentColor">
        <ellipse cx="12" cy="27" rx="2.8" ry="2.1" transform="rotate(-18 12 27)" />
        <rect x="14.2" y="10" width="1" height="17" />
        <ellipse cx="27" cy="24" rx="2.8" ry="2.1" transform="rotate(-18 27 24)" />
        <rect x="29.2" y="8.6" width="1" height="15.4" />
        <ellipse cx="42" cy="21" rx="2.8" ry="2.1" transform="rotate(-18 42 21)" />
        <rect x="44.2" y="7.2" width="1" height="13.8" />
        <ellipse cx="57" cy="18" rx="2.8" ry="2.1" transform="rotate(-18 57 18)" />
        <rect x="59.2" y="5.8" width="1" height="12.2" />
        <rect x="14.2" y="9" width="46" height="2.4" transform="skewY(-5.4)" />
        <ellipse cx="90" cy="15" rx="2.8" ry="2.1" transform="rotate(-18 90 15)" />
        <rect x="92.2" y="0" width="1" height="15" />
        <ellipse cx="106" cy="12" rx="2.8" ry="2.1" transform="rotate(-18 106 12)" />
        <rect x="108.2" y="-1" width="1" height="13" />
        <ellipse cx="126" cy="15" rx="3.4" ry="2.5" transform="rotate(-18 126 15)" />
        <rect x="92.2" y="0.4" width="17" height="2.4" transform="skewY(-4)" />
    </g>,
    // Falling pairs closing on a half note.
    <g key="descent" fill="currentColor">
        <ellipse cx="12" cy="12" rx="2.8" ry="2.1" transform="rotate(-18 12 12)" />
        <rect x="14.2" y="-3" width="1" height="15" />
        <ellipse cx="28" cy="15" rx="2.8" ry="2.1" transform="rotate(-18 28 15)" />
        <rect x="30.2" y="-1.6" width="1" height="16.6" />
        <rect x="14.2" y="-3" width="17" height="2.4" transform="skewY(5)" />
        <ellipse cx="50" cy="18" rx="2.8" ry="2.1" transform="rotate(-18 50 18)" />
        <rect x="52.2" y="2" width="1" height="16" />
        <ellipse cx="66" cy="21" rx="2.8" ry="2.1" transform="rotate(-18 66 21)" />
        <rect x="68.2" y="3.4" width="1" height="17.6" />
        <rect x="52.2" y="2" width="17" height="2.4" transform="skewY(5)" />
        <ellipse
            cx="96"
            cy="24"
            rx="3.2"
            ry="2.4"
            transform="rotate(-18 96 24)"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
        />
        <rect x="98.8" y="8" width="1" height="16" />
        <ellipse cx="126" cy="18" rx="3" ry="2.2" transform="rotate(-18 126 18)" />
        <rect x="128.4" y="2.4" width="1" height="15.6" />
    </g>,
];

/** Stable figure choice from the title, so a card keeps its bars across renders. */
const figureFor = (title: string): number => {
    let sum = 0;
    for (let i = 0; i < title.length; i++) {
        sum = (sum + title.charCodeAt(i)) % BAR_FIGURES.length;
    }
    return sum;
};

const EngravedBars = ({ title }: { title: string }) => (
    <svg viewBox="-4 -6 158 42" className="mx-auto w-[calc(100%-0.75rem)] shrink-0 text-ink/20" aria-hidden="true">
        <g stroke="currentColor" strokeWidth={0.5}>
            {[6, 12, 18, 24, 30].map((y) => (
                <line key={y} x1={0} x2={150} y1={y} y2={y} />
            ))}
            <line x1={0.5} x2={0.5} y1={6} y2={30} strokeWidth={1} />
            <line x1={76} x2={76} y1={6} y2={30} strokeWidth={0.8} />
            <line x1={148} x2={148} y1={6} y2={30} strokeWidth={1} />
            <line x1={150} x2={150} y1={6} y2={30} strokeWidth={2} />
        </g>
        {BAR_FIGURES[figureFor(title)]}
    </svg>
);

export const TypesetCover = ({
    title,
    composer,
    className = 'pt-10',
}: {
    title: string;
    composer: string | null;
    className?: string;
}) => (
    <div className={`relative flex h-full w-full flex-col bg-[#fefdf9] px-4 pb-3.5 text-center ${className}`}>
        <div className="pointer-events-none absolute inset-2 rounded-[3px] border border-ink/15">
            <div className="absolute inset-[3px] rounded-[2px] border-[0.5px] border-ink/10" />
        </div>
        <div className="min-h-0">
            <p className="font-display text-sm font-semibold leading-snug text-stone-800 line-clamp-4">{title}</p>
            <svg viewBox="0 0 46 8" className="mx-auto mt-2.5 w-11 text-ink/25" aria-hidden="true">
                <path d="M0 4h16M30 4h16" stroke="currentColor" strokeWidth={0.7} />
                <path d="M23 0.8 26 4l-3 3.2L20 4z" fill="currentColor" />
            </svg>
            {composer ? (
                <p className="mt-2 truncate text-[0.6rem] uppercase tracking-[0.14em] text-stone-500">{composer}</p>
            ) : null}
        </div>
        {/* Flex, not absolute: a four-line title squeezes the lyre instead of colliding with it. */}
        <div className="flex min-h-0 flex-1 items-center justify-center py-2">
            <Lyre />
        </div>
        <EngravedBars title={title} />
    </div>
);
