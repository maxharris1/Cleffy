import type { ReactNode } from 'react';

import { TypesetCover } from '@/ui/TypesetCover';

/**
 * One IMSLP work as a card on the search shelf, used for live hits and the
 * curated Popular list alike. The cover is always a typeset title page —
 * IMSLP's API returns no images, so unlike the library there is never an
 * engraved first page to show.
 *
 * The whole card is a single button (hits open the work panel, they are not
 * links), so no stretched-link layering is needed. `library-card` and
 * `library-card-cover` are reused from the library shelf on purpose: the
 * entrance stagger, hover lift and their `prefers-reduced-motion` overrides
 * are design-system behaviours, not library ones.
 */
export const ImslpScoreCard = ({
    coverTitle,
    coverComposer,
    title,
    composer,
    tags,
    description,
    index,
    disabled,
    onClick,
}: {
    /** Plain text for the decorative cover (no highlight marks inside aria-hidden). */
    coverTitle: string;
    coverComposer: string | null;
    /** May carry highlight <mark>s — rendered in the real, readable title. */
    title: ReactNode;
    composer?: ReactNode | null;
    /** Real per-work metadata only; the row is omitted when there is none. */
    tags?: string[];
    description?: ReactNode | null;
    index: number;
    disabled: boolean;
    onClick: () => void;
}) => (
    <li className="library-card" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="group block w-full text-left transition disabled:opacity-50"
        >
            <div
                aria-hidden="true"
                className="library-card-cover aspect-[1/1.414] overflow-hidden rounded-md border border-stone-200/80 bg-white shadow-sm"
            >
                {/* pt-5: no favourite star to clear here, unlike the library cover. */}
                <TypesetCover title={coverTitle} composer={coverComposer} className="pt-5" />
            </div>
            <span className="mt-2.5 block">
                {/*
                  No `block` on the title span: line-clamp needs
                  `display: -webkit-box`, and the two utilities set the same
                  property (see ScoreCard's identical note).
                */}
                <span className="text-sm font-medium text-stone-800 transition line-clamp-2 group-hover:text-accent-hover">
                    {title}
                </span>
                {composer ? <span className="mt-0.5 block truncate text-xs text-stone-500">{composer}</span> : null}
                {tags && tags.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                            <span
                                key={tag}
                                className="rounded-full bg-ink/5 px-1.5 py-0.5 text-[0.65rem] font-medium text-stone-600"
                            >
                                {tag}
                            </span>
                        ))}
                    </span>
                ) : null}
                {description ? (
                    <span className="mt-1 block text-xs leading-relaxed text-stone-500/90 line-clamp-2">
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    </li>
);
