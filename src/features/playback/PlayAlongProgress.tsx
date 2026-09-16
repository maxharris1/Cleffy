/**
 * The score page's view of a requested play-along: (queued →) analyzing →
 * ready. The queue step is drawn only when the job has actually been seen
 * waiting for a worker (`useScoreAnalysis` proves it before setting
 * `queued`); a fast claim or a corpus hit never shows it. Queue position is
 * not exposed to the client, so the queued stage says so in words.
 */
export type PlayAlongStage = 'queued' | 'analyzing' | 'ready';

export interface PlayAlongProgressProps {
    stage: PlayAlongStage;
    /** The job was observed waiting earlier, so keep the Queued step drawn as done. */
    queued?: boolean;
    /** Pages processed so far, while analyzing. */
    progress?: number | null;
    pageCount?: number | null;
    className?: string;
}

const STEPS: readonly { stage: PlayAlongStage; label: string }[] = [
    { stage: 'queued', label: 'Queued for analysis' },
    { stage: 'analyzing', label: 'Analyzing' },
    { stage: 'ready', label: 'Ready' },
];

const statusText = (props: PlayAlongProgressProps): string => {
    switch (props.stage) {
        case 'queued':
            return 'Every worker is busy — analysis starts as soon as one is free.';
        case 'analyzing': {
            const progress = props.progress ?? null;
            const pages =
                progress !== null && progress > 0
                    ? ` ${progress}${props.pageCount ? ` / ${props.pageCount}` : ''} pages`
                    : '';
            return `Analyzing score…${pages}`;
        }
        case 'ready':
            return 'Ready to play.';
        default: {
            const exhaustive: never = props.stage;
            throw new Error(`unhandled stage ${exhaustive}`);
        }
    }
};

export const PlayAlongProgress = (props: PlayAlongProgressProps) => {
    const { stage, queued = false, className = '' } = props;
    const steps = STEPS.filter((step) => step.stage !== 'queued' || stage === 'queued' || queued);
    const currentIndex = steps.findIndex((step) => step.stage === stage);
    return (
        <div
            className={`flex flex-col items-center gap-1${className ? ` ${className}` : ''}`}
            data-testid="play-along-progress"
        >
            <ol aria-label="Preparing your play-along" className="flex items-center gap-1.5">
                {steps.map((step, index) => {
                    const done = index < currentIndex;
                    const current = index === currentIndex;
                    return (
                        <li
                            key={step.stage}
                            aria-current={current ? 'step' : undefined}
                            className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide"
                        >
                            <span
                                aria-hidden="true"
                                className={[
                                    'h-2 w-2 rounded-full',
                                    done ? 'bg-accent' : current ? 'animate-pulse bg-accent' : 'bg-stone-300',
                                ].join(' ')}
                            />
                            <span className={current ? 'text-accent' : done ? 'text-stone-600' : 'text-stone-400'}>
                                {step.label}
                            </span>
                            {index < steps.length - 1 ? (
                                <span
                                    aria-hidden="true"
                                    className={`h-px w-4 ${done ? 'bg-accent' : 'bg-stone-300'}`}
                                />
                            ) : null}
                        </li>
                    );
                })}
            </ol>
            <p role="status" className="text-sm text-stone-500">
                {statusText(props)}
            </p>
        </div>
    );
};
