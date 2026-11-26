export type WordmarkTone = 'paper' | 'ink';

const TONE_CLASSES: Record<WordmarkTone, { text: string; rule: string }> = {
    paper: { text: 'text-ink', rule: 'bg-accent' },
    ink: { text: 'text-paper', rule: 'bg-ink-rule' },
};

export interface WordmarkProps {
    tone?: WordmarkTone;
    className?: string;
}

export const Wordmark = ({ tone = 'paper', className = '' }: WordmarkProps) => {
    const { text, rule } = TONE_CLASSES[tone];
    return (
        <span
            className={`display-opsz inline-flex items-center gap-[0.36em] font-display font-semibold tracking-[-0.01em] ${text} ${className}`}
        >
            Cleffy
            <span aria-hidden="true" className={`mt-[0.18em] h-[2px] w-[0.95em] ${rule}`} />
        </span>
    );
};
