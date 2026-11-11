/**
 * Placeholder shapes for the moment between mount and the first paint of real
 * data. A skeleton in the shape of what is coming reads as "loading" without
 * the layout jumping when the list lands; the status text stays in the tree
 * for screen readers (and for tests that already look for it), just not on
 * screen.
 */

const BLOCK = 'animate-pulse rounded bg-stone-200/70';

export const SkeletonBlock = ({ className = '' }: { className?: string }) => (
    <span aria-hidden="true" className={`block ${BLOCK} ${className}`} />
);

const Status = ({ label }: { label: string }) => (
    <p role="status" className="sr-only">
        {label}
    </p>
);

/** The library shelf or list, in its own grid so the cards land in place. */
export const LibrarySkeleton = ({
    view,
    label,
    count = 8,
}: {
    view: 'grid' | 'list';
    label: string;
    count?: number;
}) => (
    <section className="mt-8" aria-busy="true">
        <Status label={label} />
        {/* Search box and controls row, so the header does not drop in later. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SkeletonBlock className="h-8 w-full sm:max-w-xs" />
            <SkeletonBlock className="h-4 w-20" />
        </div>
        <div className="mt-3 flex gap-2">
            <SkeletonBlock className="h-8 w-24 rounded-lg" />
            <SkeletonBlock className="h-8 w-32 rounded-full" />
        </div>
        {view === 'grid' ? (
            <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {Array.from({ length: count }, (_, i) => (
                    <div key={i}>
                        <SkeletonBlock className="aspect-[1/1.414] w-full rounded-md" />
                        <SkeletonBlock className="mt-2.5 h-3.5 w-4/5" />
                        <SkeletonBlock className="mt-1.5 h-3 w-1/2" />
                    </div>
                ))}
            </div>
        ) : (
            <ul className="mt-4">
                {Array.from({ length: count }, (_, i) => (
                    <li key={i} className="flex items-center gap-3 border-b border-stone-300/50 py-3">
                        <SkeletonBlock className="h-12 w-9 shrink-0 rounded-md" />
                        <div className="flex-1">
                            <SkeletonBlock className="h-3.5 w-1/2" />
                            <SkeletonBlock className="mt-1.5 h-3 w-1/4" />
                        </div>
                        <SkeletonBlock className="h-3 w-16" />
                    </li>
                ))}
            </ul>
        )}
    </section>
);

/** Roster rows: an avatar-sized dot, a name, a count at the far end. */
export const RosterSkeleton = ({ label, count = 5 }: { label: string; count?: number }) => (
    <section className="mt-8" aria-busy="true">
        <Status label={label} />
        <SkeletonBlock className="h-3.5 w-40" />
        <ul className="mt-6">
            {Array.from({ length: count }, (_, i) => (
                <li key={i} className="flex items-center gap-3 border-b border-stone-300/50 py-3.5">
                    <SkeletonBlock className="h-8 w-8 shrink-0 rounded-full" />
                    <SkeletonBlock className="h-3.5 w-1/3" />
                    <SkeletonBlock className="ml-auto h-3 w-14" />
                </li>
            ))}
        </ul>
    </section>
);

/** A student's assigned pieces: title-height cards with a badge slot. */
export const AssignmentsSkeleton = ({ label, count = 4 }: { label: string; count?: number }) => (
    <div className="mt-6" aria-busy="true">
        <Status label={label} />
        <ul className="space-y-3">
            {Array.from({ length: count }, (_, i) => (
                <li key={i} className="rounded-xl border border-stone-300/60 bg-white/70 px-4 py-3.5">
                    <div className="flex items-center gap-2.5">
                        <SkeletonBlock className="h-5 w-2/3" />
                        <SkeletonBlock className="ml-auto h-5 w-16 rounded-full" />
                    </div>
                </li>
            ))}
        </ul>
    </div>
);
