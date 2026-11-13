import type { CSSProperties } from 'react';

import { ScoreInk } from '@/features/marketing/ScoreInk';
import { useHandwritingReady } from '@/features/marketing/useHandwritingReady';
import { useInViewOnce } from '@/features/marketing/useInViewOnce';

const rise = (i: number) => ({ '--i': i }) as CSSProperties;

/** Handwritten "live", with an arrow from the tablet to the phone: down when they stack, across beside each other. */
const LiveArrow = () => (
    <div
        aria-hidden="true"
        className="ink-rise my-2.5 flex flex-none items-center justify-center gap-2 text-ink-hand lg:my-0 lg:flex-col lg:gap-0.5"
        style={rise(2)}
    >
        <span className="inline-block -rotate-5 font-hand text-[34px] leading-none font-bold lg:text-[40px]">live</span>
        <svg
            viewBox="0 0 40 70"
            className="h-[46px] w-[26px] lg:hidden"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M 22 6 C 12 24, 14 44, 22 62" />
            <path d="M 8 50 L 22 64 L 34 48" />
        </svg>
        <svg
            viewBox="0 0 90 40"
            className="hidden h-9 w-20 lg:block"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M 6 24 C 30 10, 56 10, 80 22" />
            <path d="M 66 10 L 82 22 L 64 30" />
        </svg>
    </div>
);

/**
 * "Draw here. It shows up there.": the same marked-up page on a teacher's
 * tablet and a student's phone. The frames are plain rounded slabs, not any
 * maker's device. When the band comes into view the marks draw on the tablet
 * and, 150ms behind, on the phone: the lag is what reads as live.
 */
export const LiveInkBand = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.2);
    const handwritingReady = useHandwritingReady();
    return (
        <section ref={ref} aria-labelledby="live-title" className={`ink-band${inView ? ' is-revealed' : ''}`}>
            <div className="safe-landing-gutter mx-auto w-full max-w-6xl pt-[60px] pb-16 lg:pt-24 lg:pb-[104px]">
                <div className="max-w-[720px]">
                    <h2
                        id="live-title"
                        className="ink-rise font-display text-[44px] leading-[1.02] font-semibold tracking-[-0.02em] lg:text-[clamp(44px,5vw,72px)]"
                        style={rise(0)}
                    >
                        Draw here. <em>It shows up there.</em>
                    </h2>
                    <p
                        className="ink-rise mt-4 text-lg leading-normal text-stone-300 lg:mt-[22px] lg:text-xl lg:leading-[1.55]"
                        style={rise(1)}
                    >
                        Strokes stream to everyone as they’re drawn, not after. Any editor can erase or refine any mark.
                    </p>
                </div>
                <div
                    className={`mt-8 flex flex-col items-center lg:mt-14 lg:flex-row lg:gap-10${
                        inView && handwritingReady ? ' is-inview' : ''
                    }`}
                >
                    <figure className="ink-rise w-full min-w-0 lg:flex-[1.8_1_0%]" style={rise(1)}>
                        <div className="ink-device rounded-[22px] p-[9px] lg:rounded-[26px] lg:p-3">
                            <div className="rounded-[13px] bg-white px-3 pt-3 pb-2.5 lg:rounded-[14px] lg:px-5 lg:pt-5 lg:pb-4">
                                <ScoreInk
                                    alt="Für Elise on a tablet, with a red circle, a note and a highlight being drawn"
                                    size="tablet"
                                />
                            </div>
                        </div>
                        <figcaption className="mt-3 text-sm text-stone-300 lg:mt-4 lg:text-[15px]">
                            Ms. Davis’s tablet
                        </figcaption>
                    </figure>
                    <LiveArrow />
                    <figure
                        className="ink-rise w-[250px] max-w-full min-w-0 sm:w-[340px] lg:w-auto lg:flex-[1_1_0%]"
                        style={rise(3)}
                    >
                        <div className="ink-device rounded-[18px] p-[7px] lg:rounded-[22px] lg:p-2">
                            <div className="rounded-[11px] px-[9px] pt-[9px] pb-2 bg-white lg:rounded-[14px] lg:px-3 lg:pt-3 lg:pb-2.5">
                                <ScoreInk
                                    alt="The same page of Für Elise on a phone, showing the same marks"
                                    size="phone"
                                    offset={0.15}
                                />
                            </div>
                        </div>
                        <figcaption className="mt-3 text-center text-sm text-stone-300 lg:mt-4 lg:text-left lg:text-[15px]">
                            Leo’s phone
                        </figcaption>
                    </figure>
                </div>
            </div>
        </section>
    );
};
