import type { HandSpan } from '@/features/fingering/engine/span';

export interface HandSpanToggleProps {
    value: HandSpan;
    onChange: (span: HandSpan) => void;
}

/** Compact small/standard/large control shared by review and diagram panels. */
export const HandSpanToggle = ({ value, onChange }: HandSpanToggleProps) => (
    <div role="group" aria-label="Hand size" className="flex items-center gap-1 text-xs text-stone-600">
        <span className="text-stone-500">Hand size</span>
        {(['small', 'standard', 'large'] as const).map((size) => (
            <button
                key={size}
                type="button"
                aria-pressed={value === size}
                onClick={() => onChange(size)}
                className={`rounded-md border px-1.5 py-0.5 capitalize transition ${
                    value === size
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-stone-200 hover:bg-stone-50'
                }`}
            >
                {size}
            </button>
        ))}
    </div>
);
