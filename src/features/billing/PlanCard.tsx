import type { ReactNode } from 'react';

import { CheckIcon } from '@/ui/icons';

type PlanCardTone = 'paper' | 'ink';

const TONES: Record<PlanCardTone, { card: string; secondary: string; note: string; status: string; tick: string }> = {
    paper: {
        card: 'border-panel-line bg-transparent text-ink',
        secondary: 'text-ink-muted',
        note: 'text-ok',
        status: 'text-amber-800',
        tick: 'text-tick',
    },
    ink: {
        card: 'border-ink bg-ink text-paper shadow-[0_30px_50px_-30px_rgba(28,25,23,0.7)]',
        secondary: 'text-on-ink-muted',
        note: 'text-[#4ade80]',
        status: 'text-amber-300',
        tick: 'text-[#4ade80]',
    },
};

export interface PlanCardProps {
    name: string;
    badge?: ReactNode;
    price?: { amount: string; caption: string } | null;
    description?: string;
    note?: string;
    status?: string;
    features?: readonly string[];
    /** The plan the account is on: the one ink card, marked rather than sold. */
    current?: boolean;
    action?: ReactNode;
}

export const PlanCard = ({
    name,
    badge,
    price,
    description,
    note,
    status,
    features = [],
    current = false,
    action,
}: PlanCardProps) => {
    const tone = TONES[current ? 'ink' : 'paper'];
    return (
        <section
            className={`flex min-w-0 flex-1 basis-full flex-col rounded-2xl border p-[22px] sm:basis-[calc(50%-7px)] lg:basis-[210px] ${tone.card}`}
        >
            <h3 className="min-w-0 text-base font-semibold [overflow-wrap:anywhere]">
                {name}
                {badge}
                {current ? <span className="sr-only"> Current plan</span> : null}
            </h3>
            {price ? (
                <>
                    <p className="mt-2.5 font-display text-[44px] leading-none font-semibold tabular-nums">
                        {price.amount}
                    </p>
                    <p className={`mt-1.5 text-[13px] tabular-nums ${tone.secondary}`}>{price.caption}</p>
                </>
            ) : null}
            {note ? <p className={`mt-1 text-xs ${tone.note}`}>{note}</p> : null}
            {description ? <p className={`mt-3.5 text-sm leading-[1.45] ${tone.secondary}`}>{description}</p> : null}
            {status ? <p className={`mt-1 text-sm ${tone.status}`}>{status}</p> : null}
            {features.length > 0 ? (
                <ul className="mt-4 flex flex-col gap-2">
                    {features.map((feature) => (
                        <li key={feature} className="flex items-start gap-2 text-sm leading-[1.4]">
                            <CheckIcon size={16} strokeWidth={2.4} className={`mt-px flex-none ${tone.tick}`} />
                            <span>{feature}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="mt-auto pt-5">
                {current ? (
                    <div className="flex min-h-11 items-center">
                        <span
                            aria-hidden="true"
                            className="inline-flex h-6 items-center rounded-full bg-paper/14 px-2.5 text-xs font-semibold text-paper"
                        >
                            Current plan
                        </span>
                    </div>
                ) : null}
                {action}
            </div>
        </section>
    );
};
