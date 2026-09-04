import { LayoutGridIcon, ListIcon } from '@/ui/icons';

export type ToggleView = 'grid' | 'list';

/**
 * Shelf or list. Two icon buttons rather than a select: it is a two-state
 * choice made rarely, and the icons say what the words would.
 */
export const ViewToggle = ({ view, onChange }: { view: ToggleView; onChange: (v: ToggleView) => void }) => (
    <div
        role="group"
        aria-label="View"
        className="flex h-8 shrink-0 items-center rounded-lg border border-stone-200 p-0.5"
    >
        {(
            [
                ['grid', 'Grid view', LayoutGridIcon],
                ['list', 'List view', ListIcon],
            ] as const
        ).map(([value, label, Icon]) => (
            <button
                key={value}
                type="button"
                aria-pressed={view === value}
                aria-label={label}
                title={label}
                onClick={() => onChange(value)}
                className={`flex h-full items-center rounded-md px-2 transition ${
                    view === value ? 'bg-accent-soft text-accent' : 'text-stone-500 hover:text-stone-800'
                }`}
            >
                <Icon size={15} />
            </button>
        ))}
    </div>
);
