import { buttonClassName } from '@/ui/classNames';
import { Volume2Icon } from '@/ui/icons';

export interface StepHearBarProps {
    /** When set with more than one step, shows ‹ › and a counter. */
    step?: { current: number; total: number; onPrev: () => void; onNext: () => void };
    hearing: boolean;
    hearDisabled: boolean;
    onHear: () => void;
}

/** Shared step stepper + Hear control for review and diagram panels. */
export const StepHearBar = ({ step, hearing, hearDisabled, onHear }: StepHearBarProps) => (
    <div className="flex items-center gap-1.5">
        {step && step.total > 1 ? (
            <>
                <button
                    type="button"
                    aria-label="Previous step"
                    disabled={step.current <= 0}
                    onClick={step.onPrev}
                    className={buttonClassName('secondary', 'sm', 'px-2.5')}
                >
                    ‹
                </button>
                <span className="text-xs tabular-nums text-stone-600">
                    {step.current + 1} / {step.total}
                </span>
                <button
                    type="button"
                    aria-label="Next step"
                    disabled={step.current >= step.total - 1}
                    onClick={step.onNext}
                    className={buttonClassName('secondary', 'sm', 'px-2.5')}
                >
                    ›
                </button>
            </>
        ) : null}
        <button
            type="button"
            aria-label="Hear this step"
            disabled={hearDisabled || hearing}
            onClick={onHear}
            className={buttonClassName('secondary', 'sm', 'inline-flex items-center gap-1.5')}
        >
            <Volume2Icon size={14} aria-hidden />
            Hear
        </button>
    </div>
);
