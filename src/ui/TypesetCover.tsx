/**
 * Stand-in cover for a score with no rendered page image — the library shelf
 * uses it until a first page is cached on this device, and IMSLP search cards
 * use it always (IMSLP hits carry no image data).
 *
 * Set like an engraved edition title plate rather than left blank: warm paper,
 * a double hairline frame, the title over a small fleuron divider, and a staff
 * footer. The frame is what keeps a shelf of short titles from reading as
 * empty white cards. Purely decorative — the enclosing cover is aria-hidden
 * and the card's own title already names the score.
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
    <div
        className={`relative flex h-full w-full flex-col justify-between bg-[#fefdf9] px-4 pb-3.5 text-center ${className}`}
    >
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
        <svg viewBox="0 0 40 14" className="mx-auto w-[calc(100%-1.5rem)] shrink-0 text-[#e3e0d6]" aria-hidden="true">
            {[1, 4, 7, 10, 13].map((y) => (
                <line key={y} x1={2} x2={38} y1={y} y2={y} stroke="currentColor" strokeWidth={0.4} />
            ))}
        </svg>
    </div>
);
