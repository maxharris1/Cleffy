import { Link } from 'react-router';

import { composerOf, displayTitleOf } from '@/features/library/libraryView';
import { formatUpdated } from '@/features/library/libraryFormat';
import { RowMenu } from '@/features/library/RowMenu';
import { useScoreThumbnail } from '@/features/library/useScoreThumbnail';
import type { DocumentRow, LibraryTagRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { StarIcon } from '@/ui/icons';

/**
 * Overlay controls on a cover: always in the DOM and always focusable, faded
 * out until the card is hovered or something inside it takes focus.
 *
 * Never `hidden` and never conditionally rendered — a keyboard user tabbing the
 * shelf has to reach the star and the menu, and the tests find them by role.
 * Touch has no hover at all, so there they stay visible rather than sitting
 * over the cover as invisible tap targets.
 */
const REVEAL =
    'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * Stand-in cover for a score whose first page has not been rendered on this
 * device yet — it is only cached once the score has been opened or uploaded
 * here, so a fresh browser meets a shelf of these.
 *
 * Set like a printed title page rather than left blank: a wall of identical
 * empty staves would be less scannable than the list it replaced, so the type
 * carries the recognition until the real page arrives. Purely decorative — the
 * enclosing cover is aria-hidden and the title link already names the score.
 */
const CoverFallback = ({ title, composer }: { title: string; composer: string | null }) => (
    /* pt-10 clears the favourite star pinned to the cover's top-right corner —
       on a favourited score it is always lit, and a centred title ran under it. */
    <div className="flex h-full w-full flex-col justify-between bg-white px-3 pb-3 pt-10 text-center">
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

/**
 * One score on the shelf: its engraved first page as the cover, with title,
 * composer and meta beneath.
 *
 * The title is the only link — its `after:` pseudo-element stretches across the
 * whole card, so every other control has to paint above it. `relative` alone is
 * not enough here (unlike the list row): the cover and its controls come BEFORE
 * the link in DOM order, where a later positioned sibling would win, hence the
 * explicit `z-10`.
 *
 * Tags are deliberately not shown — five to six cards per row cannot carry chip
 * rows without turning into noise. They survive in the card's tooltip, and the
 * list view remains the place to see and filter them.
 */
export const ScoreCard = ({
    doc,
    index,
    stripComposer,
    assignedTags,
    isFavorite,
    isOwner,
    onToggleFavorite,
    onRename,
    onShare,
    onAssign,
    onDelete,
}: {
    doc: DocumentRow;
    index: number;
    stripComposer: boolean;
    assignedTags: LibraryTagRow[];
    isFavorite: boolean;
    isOwner: boolean;
    onToggleFavorite: () => void;
    onRename: () => void;
    onShare: () => void;
    onAssign: () => void;
    onDelete: () => void;
}) => {
    const url = useScoreThumbnail(doc.id, doc.content_rev ?? 0);
    // Suppressed under a composer group header, which already says it — five
    // cards in a row repeating "Bach, Johann Sebastian" is noise, not context.
    const composer = stripComposer ? null : composerOf(doc.title);
    // Whenever the composer gets its own line the title drops its trailing
    // "(Chopin)" — printing both turns every card into an echo.
    const title = stripComposer || composer ? displayTitleOf(doc.title) : doc.title;
    const pages = doc.page_count ? `${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'} · ` : '';
    const tagNames = assignedTags.map((t) => t.name);

    return (
        <div
            className="library-card group relative has-[[aria-expanded=true]]:z-20"
            style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            // Titles clamp to two lines and tags have no room on a cover, so the
            // tooltip carries the parts the card had to drop.
            title={tagNames.length > 0 ? `${doc.title} · ${tagNames.join(' · ')}` : doc.title}
        >
            {/*
              The clipped cover and the controls are siblings on purpose: the
              action menu opens downward past the cover's bottom edge, and
              `overflow-hidden` would slice it in half.
            */}
            <div className="relative">
                <div
                    aria-hidden="true"
                    className="library-card-cover aspect-[1/1.414] overflow-hidden rounded-md border border-stone-200/80 bg-white shadow-sm"
                >
                    {url ? (
                        <img src={url} alt="" className="h-full w-full object-cover object-top" />
                    ) : (
                        <CoverFallback title={title} composer={composer} />
                    )}
                </div>

                <div className={`absolute right-1.5 top-1.5 z-10 ${isFavorite ? '' : REVEAL}`}>
                    <button
                        type="button"
                        aria-pressed={isFavorite}
                        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={onToggleFavorite}
                        className={`rounded-full bg-white/85 p-1.5 backdrop-blur transition hover:bg-white ${
                            isFavorite ? 'text-amber-500' : 'text-stone-500 hover:text-stone-700'
                        }`}
                    >
                        <StarIcon size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                </div>

                {isOwner ? (
                    // `has-[[aria-expanded=true]]` keeps the pill lit while its
                    // own menu is open — otherwise moving the pointer onto the
                    // menu fades out the menu with it.
                    <div
                        className={`absolute bottom-1.5 right-1.5 z-10 rounded-full bg-white/85 backdrop-blur has-[[aria-expanded=true]]:opacity-100 ${REVEAL}`}
                    >
                        <RowMenu onRename={onRename} onShare={onShare} onAssign={onAssign} onDelete={onDelete} />
                    </div>
                ) : null}

                {/* Past the free cap: still readable and exportable, just not writable. */}
                {doc.archived_at ? (
                    <span
                        className="absolute bottom-1.5 left-1.5 z-10"
                        title="Read-only — over your plan’s score limit"
                    >
                        <Badge tone="warn">Archived</Badge>
                    </span>
                ) : null}
            </div>

            <div className="mt-2.5">
                {/*
                  No `block` here: line-clamp-2 needs `display: -webkit-box`,
                  and the two utilities set the same property — whichever
                  Tailwind emits last wins, which is how a three-line title got
                  through.
                */}
                <Link
                    to={`/doc/${doc.id}`}
                    // Ungrouped, the visible title drops its "(Chopin)" because
                    // the composer has its own line — but the link still has to
                    // name the score in full for anyone reading it out of
                    // context. Under a composer heading there is nothing to
                    // restore, so the visible text stands on its own.
                    aria-label={!stripComposer && composer ? doc.title : undefined}
                    className="text-sm font-medium text-stone-800 transition line-clamp-2 group-hover:text-accent-hover after:absolute after:inset-0 after:content-['']"
                >
                    {title}
                </Link>
                {composer ? <p className="mt-0.5 truncate text-xs text-stone-500">{composer}</p> : null}
                <p className="mt-0.5 text-xs text-stone-400">
                    {pages}
                    {formatUpdated(doc.updated_at)}
                </p>
            </div>
        </div>
    );
};
