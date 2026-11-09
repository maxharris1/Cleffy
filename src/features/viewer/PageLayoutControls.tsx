import { useRef, type KeyboardEvent } from 'react';

import type { PageColumns } from '@/features/viewer/geometry';
import { CheckboxCheckedIcon, CheckboxIcon, SinglePageIcon, TwoPagesIcon } from '@/ui/icons';

const LAYOUTS = [
    { columns: 1, label: 'Single page', Icon: SinglePageIcon },
    { columns: 2, label: 'Two pages side by side', Icon: TwoPagesIcon },
] as const;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);

/**
 * The viewer's page layout: Single page or Two pages, one always chosen, then
 * — in two-page mode only — the cover-page option, as a checkbox chip apart
 * from the pair so it never reads as a third layout.
 *
 * The pair is a radio group: the chosen layout is the one tab stop, the arrow
 * keys move the choice (as in any radio group), and choosing the layout
 * already shown does nothing.
 */
export const PageLayoutControls = ({
    pageColumns,
    onPageColumnsChange,
    spreadCover,
    onSpreadCoverChange,
}: {
    pageColumns: PageColumns;
    onPageColumnsChange: (columns: PageColumns) => void;
    spreadCover: boolean;
    onSpreadCoverChange: (spreadCover: boolean) => void;
}) => {
    const radios = useRef<(HTMLButtonElement | null)[]>([]);

    const choose = (columns: PageColumns) => {
        if (columns !== pageColumns) {
            onPageColumnsChange(columns);
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!ARROW_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }
        // Two choices: every arrow lands on the other one.
        e.preventDefault();
        const other: PageColumns = pageColumns === 1 ? 2 : 1;
        choose(other);
        radios.current[other - 1]?.focus();
    };

    return (
        <>
            <div
                role="radiogroup"
                aria-label="Page layout"
                onKeyDown={onKeyDown}
                className="flex flex-row gap-0.5 rounded-full bg-white p-0.5 shadow-md sm:flex-col sm:[@media(max-height:500px)]:flex-row"
            >
                {LAYOUTS.map(({ columns, label, Icon }) => {
                    const checked = columns === pageColumns;
                    return (
                        <button
                            key={columns}
                            ref={(el) => {
                                radios.current[columns - 1] = el;
                            }}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            aria-label={label}
                            title={label}
                            tabIndex={checked ? 0 : -1}
                            onClick={() => choose(columns)}
                            className={`flex h-10 w-10 items-center justify-center rounded-full transition-[scale] duration-(--duration-press) ease-out active:scale-[0.97] ${
                                checked ? 'bg-accent-soft text-accent' : 'text-stone-700 hover:bg-stone-100'
                            }`}
                        >
                            <Icon size={20} />
                        </button>
                    );
                })}
            </div>
            {pageColumns === 2 ? (
                <button
                    type="button"
                    aria-pressed={spreadCover}
                    title="Show the first page on its own, so the spreads pair pages 2|3, 4|5 as in a printed score"
                    onClick={() => onSpreadCoverChange(!spreadCover)}
                    className={`relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium shadow-sm pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5 ${
                        // The tint is translucent: lay it over white so the score does not show through.
                        spreadCover
                            ? 'border-accent bg-white bg-linear-to-r from-accent-soft to-accent-soft text-accent'
                            : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50'
                    }`}
                >
                    {spreadCover ? <CheckboxCheckedIcon size={14} /> : <CheckboxIcon size={14} />}
                    Start with cover page
                </button>
            ) : null}
        </>
    );
};
