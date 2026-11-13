import type { CSSProperties } from 'react';

import { initialBillingCountry } from '@/features/billing/billingRegion';
import { priceFor, tierCards } from '@/features/billing/pricing';
import { useInViewOnce } from '@/features/marketing/useInViewOnce';
import { features } from '@/lib/features';

import { currencyForCountry } from '../../../supabase/functions/_shared/billingTerms';

/**
 * The plans, as the pricing dialog and checkout see them: names and taglines
 * from tierCards, amounts and captions (each with its tax treatment) from
 * priceFor in the visitor's currency. Nothing here is typed in, so the page
 * cannot name a different price. The cards' feature lists stay in the dialog.
 */
export const PlansBand = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.15);
    const currency = currencyForCountry(initialBillingCountry());
    const cards = tierCards(features).flatMap((card) => {
        const price = priceFor(card.tier, 'monthly', currency);
        return price ? [{ ...card, price }] : [];
    });
    return (
        <section
            ref={ref}
            id="plans"
            tabIndex={-1}
            aria-labelledby="plans-title"
            className={`scroll-mt-4 border-t border-ink/10 pt-12 pb-14 outline-none lg:pt-[72px] lg:pb-[88px]${
                inView ? ' is-revealed' : ''
            }`}
        >
            <h2
                id="plans-title"
                className="ink-rise font-display text-[34px] leading-[1.05] font-semibold tracking-[-0.02em] lg:text-[clamp(34px,3.6vw,48px)]"
            >
                Free to start. <em>Students never pay.</em>
            </h2>
            <ul className="mt-[26px] grid gap-3 sm:grid-cols-2 sm:gap-5 lg:mt-9 lg:grid-cols-4">
                {cards.map((card, i) => {
                    const featured = card.tier === 'teacher';
                    return (
                        <li
                            key={card.tier}
                            data-tier={card.tier}
                            className={`ink-rise rounded-[14px] px-5 py-[18px] sm:rounded-2xl sm:px-6 sm:pt-[26px] sm:pb-7 ${
                                featured
                                    ? 'ink-plan-featured bg-ink text-paper'
                                    : 'border border-ink/12 bg-white text-ink'
                            }`}
                            style={{ '--i': i + 1 } as CSSProperties}
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 sm:block">
                                <h3 className="text-[17px] font-semibold">{card.name}</h3>
                                <p
                                    className={`text-[15px] tabular-nums sm:mt-3.5 sm:text-sm ${
                                        featured ? 'text-stone-300' : 'text-stone-600'
                                    }`}
                                >
                                    <span
                                        className={`font-display text-[28px] leading-none font-semibold sm:block sm:text-[44px] ${
                                            featured ? 'text-paper' : 'text-ink'
                                        }`}
                                    >
                                        {card.price.amount}
                                    </span>{' '}
                                    <span className="sm:mt-1.5 sm:block">{card.price.caption}</span>
                                </p>
                            </div>
                            <p
                                className={`mt-2 text-[15px] leading-[1.45] sm:mt-[18px] sm:leading-normal ${
                                    featured ? 'text-stone-200' : 'text-stone-700'
                                }`}
                            >
                                {card.tagline}
                            </p>
                        </li>
                    );
                })}
            </ul>
            <p className="ink-rise mt-[18px] text-sm leading-normal text-stone-600 sm:mt-6 sm:text-[15px] sm:leading-[1.55]">
                Pay annually and get two months free. Changed your mind? You get a full refund if you ask within 14 days
                of your first purchase.
            </p>
        </section>
    );
};
