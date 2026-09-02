/**
 * Stand-in cover for a score with no rendered page image — the library shelf
 * uses it until a first page is cached on this device, and IMSLP search cards
 * use it always (IMSLP hits carry no image data).
 *
 * Set like a printed title page rather than left blank: a wall of identical
 * empty staves would be less scannable than the list it replaced, so the type
 * carries the recognition until (or unless) a real page arrives. Purely
 * decorative — the enclosing cover is aria-hidden and the card's own title
 * already names the score.
 *
 * `className` sets the top padding: the library passes the default `pt-10` to
 * clear the favourite star pinned to the cover's top-right corner, while search
 * cards have no overlay controls and sit the type higher.
 */
export const TypesetCover = ({
    title,
    composer,
    className = 'pt-10',
}: {
    title: string;
    composer: string | null;
    className?: string;
}) => (
    <div className={`flex h-full w-full flex-col justify-between bg-white px-3 pb-3 text-center ${className}`}>
        <div className="min-h-0">
            <p className="font-display text-sm font-semibold leading-snug text-stone-800 line-clamp-4">{title}</p>
            {composer ? (
                <p className="mt-1.5 truncate text-[0.6rem] uppercase tracking-[0.14em] text-stone-500">{composer}</p>
            ) : null}
        </div>
        <svg viewBox="0 0 40 14" className="w-full shrink-0 text-stone-200" aria-hidden="true">
            {[1, 4, 7, 10, 13].map((y) => (
                <line key={y} x1={2} x2={38} y1={y} y2={y} stroke="currentColor" strokeWidth={0.4} />
            ))}
        </svg>
    </div>
);
