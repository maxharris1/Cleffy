export interface SuggestOptionToggleProps {
    /** Total ranked options including the primary (2 or 3). */
    count: number;
    value: number;
    onChange: (index: number) => void;
}

/** Compact Option 1/2/3 control for top-k fingering suggestions. */
export const SuggestOptionToggle = ({ count, value, onChange }: SuggestOptionToggleProps) => {
    if (count < 2) {
        return null;
    }
    return (
        <div role="group" aria-label="Suggestion option" className="flex items-center gap-1 text-xs text-stone-600">
            <span className="text-stone-500">Option</span>
            {Array.from({ length: count }, (_, i) => (
                <button
                    key={i}
                    type="button"
                    aria-pressed={value === i}
                    onClick={() => onChange(i)}
                    className={`rounded-md border px-1.5 py-0.5 tabular-nums transition ${
                        value === i
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-stone-200 hover:bg-stone-50'
                    }`}
                >
                    {i + 1}
                </button>
            ))}
        </div>
    );
};
