import { memo, useRef } from 'react';
import { Link } from 'react-router';

import { CoverImage } from '@/features/library/CoverImage';
import { composerOf, displayTitleOf } from '@/features/library/libraryView';
import { formatUpdated } from '@/features/library/libraryFormat';
import { RowMenu, SharedScoreMenu } from '@/features/library/RowMenu';
import { sameDocRow, useEntranceDelay, type ScoreActions } from '@/features/library/scoreRow';
import { useNearViewport, useScoreThumbnail } from '@/features/library/useScoreThumbnail';
import type { DocumentRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { StarIcon } from '@/ui/icons';
import { TypesetCover } from '@/ui/TypesetCover';

/**
 * The star on a cover: always in the DOM and always focusable, faded out until
 * the card is hovered or something inside it takes focus. A favourite's star
 * stays lit, as its badge.
 *
 * Never `hidden` and never conditionally rendered — a keyboard user tabbing the
 * shelf has to reach it, and the tests find it by role.
 * They appear at once, no fade: a control that is still fading in when the
 * pointer arrives reads as lag. Touch has no hover at all, so there they stay
 * visible rather than sitting over the cover as invisible tap targets — and
 * so does any coarse pointer, since hover only counts with a fine one (the
 * hover variant in index.css).
 */
const REVEAL =
    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:opacity-100';

interface ScoreCardProps {
    doc: DocumentRow;
    /** Position in the list when the card mounted — only the entrance stagger reads it. */
    index: number;
    stripComposer: boolean;
    isFavorite: boolean;
    isOwner: boolean;
    actions: ScoreActions;
}

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
 * rows without turning into noise. The list view remains the place to see and
 * filter them; the visible title (line-clamp-2) is the card's name.
 */
export const ScoreCard = memo(
    ({ doc, index, stripComposer, isFavorite, isOwner, actions }: ScoreCardProps) => {
        const rootRef = useRef<HTMLDivElement | null>(null);
        const near = useNearViewport(rootRef);
        const url = useScoreThumbnail(doc.id, doc.content_rev ?? 0, { thumbRev: doc.thumb_rev ?? null, enabled: near });
        // Suppressed under a composer group header, which already says it — five
        // cards in a row repeating "Bach, Johann Sebastian" is noise, not context.
        const composer = stripComposer ? null : composerOf(doc.title);
        // Whenever the composer gets its own line the title drops its trailing
        // "(Chopin)" — printing both turns every card into an echo.
        const title = stripComposer || composer ? displayTitleOf(doc.title) : doc.title;
        const pages = doc.page_count ? `${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'} · ` : '';
        const entranceDelay = useEntranceDelay(index);

        return (
            <div
                ref={rootRef}
                className={`library-card group relative has-[[aria-expanded=true]]:z-20${
                    entranceDelay === null ? ' library-card-settled' : ''
                }`}
                style={entranceDelay === null ? undefined : { animationDelay: `${entranceDelay}ms` }}
            >
                {/*
                  The clipped cover and the star are siblings on purpose: the
                  cover's `overflow-hidden` would clip the star's touch ring.
                */}
                <div className="relative">
                    <div
                        aria-hidden="true"
                        className="library-card-cover relative aspect-[1275/1650] overflow-hidden rounded-[4px] bg-white shadow-[0_0_0_1px_rgba(28,25,23,0.1),0_16px_30px_-20px_rgba(28,25,23,0.5)]"
                    >
                        {url ? (
                            <CoverImage
                                src={url}
                                cacheKey={`${doc.id}:${doc.content_rev ?? 0}:${doc.thumb_rev ?? ''}`}
                                placeholder={<TypesetCover title={title} composer={composer} />}
                                className="absolute inset-0 h-full w-full object-cover object-top"
                            />
                        ) : near ? (
                            /* Default pt-10 clears the favourite star pinned to the
                               cover's top-right corner — on a favourited score it is
                               always lit, and a centred title ran under it. Drawn
                               only once the card comes near the screen: a page of a
                               hundred cards would otherwise build a hundred engraved
                               plates nobody has scrolled to. */
                            <TypesetCover title={title} composer={composer} />
                        ) : null}
                    </div>

                    <div className={`absolute right-2 top-2 z-10 ${isFavorite ? '' : REVEAL}`}>
                        <button
                            type="button"
                            aria-pressed={isFavorite}
                            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                            onClick={() => actions.toggleFavorite(doc, !isFavorite)}
                            // The badge stays small on touch; an invisible ring takes the hit area to 44px.
                            className={`relative grid place-items-center rounded-full bg-white/92 p-1 transition-colors hover:bg-white pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5 ${
                                isFavorite ? 'text-amber-500' : 'text-ink-muted hover:text-ink'
                            }`}
                        >
                            <StarIcon size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                    </div>

                    {/* Past the free cap: still readable and exportable, just not writable. */}
                    {doc.archived_at ? (
                        <span className="absolute bottom-2 left-2 z-10">
                            <Badge tone="warn">Archived</Badge>
                        </span>
                    ) : null}
                </div>

                <div className="mt-3 flex items-start justify-between gap-1.5">
                    {/* Before the title in the DOM, after it on screen: the tab
                        order stays star, actions, title. */}
                    <div className="relative z-10 -mt-2.5 -mr-3 shrink-0 order-last">
                        {isOwner ? (
                            <RowMenu
                                onRename={() => actions.rename(doc)}
                                onShare={() => actions.share(doc)}
                                onAssign={actions.assign ? () => actions.assign?.(doc) : undefined}
                                onDelete={() => actions.remove(doc)}
                            />
                        ) : (
                            <SharedScoreMenu onLeave={() => actions.leave(doc)} />
                        )}
                    </div>
                    <div className="min-w-0">
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
                            className="text-[15px] font-semibold leading-[1.3] text-ink transition-colors line-clamp-2 [overflow-wrap:anywhere] group-hover:text-accent-hover after:absolute after:inset-0 after:content-['']"
                        >
                            {title}
                        </Link>
                        {composer ? <p className="mt-[3px] truncate text-[13px] text-ink-muted">{composer}</p> : null}
                        <p className="mt-[3px] text-[13px] text-ink-muted">
                            {pages}
                            {formatUpdated(doc.updated_at)}
                        </p>
                        {/* The reason, in words: a title tooltip never shows on touch. */}
                        {doc.archived_at ? (
                            <p className="mt-[3px] text-[13px] text-amber-800">
                                Read-only: over your plan’s score limit
                            </p>
                        ) : null}
                    </div>
                </div>
            </div>
        );
    },
    (prev, next) =>
        prev.stripComposer === next.stripComposer &&
        prev.isFavorite === next.isFavorite &&
        prev.isOwner === next.isOwner &&
        prev.actions === next.actions &&
        sameDocRow(prev.doc, next.doc),
);

ScoreCard.displayName = 'ScoreCard';
