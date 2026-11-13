import '@/features/marketing/landing.css';

import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { Link } from 'react-router';

import { RequireGuest } from '@/features/auth/AuthGates';
import { initialBillingCountry } from '@/features/billing/billingRegion';
import { CancelSubscriptionLink } from '@/features/billing/CancelSubscriptionLink';
import { lowestMonthlyPrice } from '@/features/billing/pricing';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { HeroDemo } from '@/features/marketing/HeroDemo';
import { SHOW_DOCS_COMPARISON } from '@/features/marketing/landingConfig';
import { StartFreeLink, TryLink } from '@/features/marketing/landingLinks';
import { LiveInkBand } from '@/features/marketing/LiveInkBand';
import { PlansBand } from '@/features/marketing/PlansBand';
import { ProductShowcase } from '@/features/marketing/ProductShowcase';
import { useInViewOnce } from '@/features/marketing/useInViewOnce';
import { scrollBehavior } from '@/lib/motion';
import { isSupabaseConfigured } from '@/lib/supabase';

import { currencyForCountry, TAX_INCLUSIVE } from '../../../supabase/functions/_shared/billingTerms';

const AUDIENCES = [
    { label: 'For your own practice', line: 'Store it. Mark it up. Open it anywhere.' },
    { label: 'For teachers', line: 'Mark it in the lesson. Everyone sees it live.' },
    { label: 'For ensembles and academies', line: 'One link. Every player marks their own part.' },
] as const;

/** Hand-drawn ticks: each a little different, as a hand would make them. */
const SHARED = [
    { label: 'Your docs', tick: 'M 8 32 C 16 38, 22 46, 28 52 C 40 32, 56 16, 74 6' },
    { label: 'Your playlists', tick: 'M 6 30 C 14 37, 21 45, 27 53 C 41 30, 57 15, 75 7' },
    { label: 'Your calendar', tick: 'M 9 33 C 16 39, 22 46, 29 51 C 40 33, 55 17, 73 8' },
] as const;

const STEPS = [
    {
        mark: 'A',
        title: 'Add a score',
        body: 'Upload a PDF, or search thousands of public-domain scores without leaving the app.',
    },
    {
        mark: 'B',
        title: 'Share the link',
        // The age sentence is a legal guardrail: word for word.
        body: 'People open it in any browser and type a name. No accounts, no installs. For ages 13 and up (older in some countries).',
    },
    {
        mark: 'C',
        title: 'Mark it up together',
        body: 'Ink streams live as everyone draws. Any editor can erase or refine any mark.',
    },
] as const;

const PEN_PATH = 'M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z';

const FEATURES = [
    { title: 'Live ink', body: 'Strokes stream to everyone as they’re drawn, not after.', icon: PEN_PATH },
    {
        title: 'Works offline',
        body: 'Annotate anywhere; changes sync when you’re back.',
        icon: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z M9.5 13.5l2 2 3.5-3.5',
    },
    {
        title: 'Public-domain library built in',
        body: 'Search public-domain scores and add them straight to your library.',
        icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
    },
    {
        title: 'Export & share',
        body: 'Send a page as a photo, or a flattened PDF of the whole score.',
        icon: 'M12 15V4 M8 8l4-4 4 4 M5 14v5h14v-5',
    },
    {
        title: 'The PDF stays pristine',
        body: 'Marks live on top. The original file is never modified.',
        icon: 'M7 3h7l4 4v14H7z M14 3v4h4',
    },
] as const;

/** The browser bar while the ink page is up; index.html's paper comes back when it goes. */
const INK = '#1c1917';

/** Stagger index for a band's rise (landing.css). */
const rise = (i: number) => ({ '--i': i }) as CSSProperties;

/** Draw-in delay for a mark (.hero-ink in index.css). */
const draw = (delay: number, duration: number) => ({ '--d': `${delay}s`, '--dur': `${duration}s` }) as CSSProperties;

/*
 * The two ink-band buttons. "Try it now" is the filled one: the demo is the
 * page's first action, Start free beside it (factory.md). Both carry the
 * press scale and, under a fine pointer, the 1px lift (landing.css).
 */
const BIG_BUTTON =
    'inline-flex min-h-14 w-full items-center justify-center whitespace-nowrap rounded-[14px] px-6 text-lg sm:min-h-[58px] sm:w-auto sm:text-[19px]';
const TRY_BUTTON = `ink-button ink-button-fill ${BIG_BUTTON} gap-2.5 bg-ink-cta font-bold text-white sm:px-[30px]`;
const START_BUTTON = `ink-button ink-button-line ${BIG_BUTTON} font-semibold text-paper`;
const NAV_START_BUTTON =
    'ink-button ink-button-line ink-button-nav inline-flex min-h-11 items-center whitespace-nowrap rounded-[10px] px-4 text-[15px] font-semibold text-paper sm:px-[18px]';
/** Display is the caller's: the nav hides these on a phone. */
const INK_LINK =
    'min-h-11 items-center whitespace-nowrap text-[15px] text-stone-300 underline decoration-stone-300/50 underline-offset-2 hover:text-paper';
const BUTTON_ROW = 'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3.5';

const PenIcon = () => (
    <svg
        viewBox="0 0 24 24"
        className="h-5 w-5 flex-none"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d={PEN_PATH} />
    </svg>
);

/**
 * While the page is up, the browser's bar and the overscroll at either end
 * are ink, so a phone's chrome continues the hero. index.html's paper
 * theme-color (kept in step with the PWA manifest) comes back on the way out.
 */
const useInkChrome = () => {
    useEffect(() => {
        const root = document.documentElement;
        root.classList.add('ink-landing-root');
        const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
        const previous = meta?.getAttribute('content') ?? null;
        meta?.setAttribute('content', INK);
        return () => {
            root.classList.remove('ink-landing-root');
            if (meta && previous !== null) {
                meta.setAttribute('content', previous);
            }
        };
    }, []);
};

/** "Plans": down to the plans, smoothly unless the visitor asked for less motion, and focus follows. */
const PlansLink = ({ className }: { className: string }) => {
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        const plans = document.getElementById('plans');
        if (!plans) {
            return;
        }
        event.preventDefault();
        plans.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
        plans.focus({ preventScroll: true });
    };
    return (
        <a href="#plans" onClick={onClick} className={className}>
            Plans
        </a>
    );
};

const Wordmark = ({ className = 'text-2xl' }: { className?: string }) => (
    <span className={`landing-brand font-display font-semibold ${className}`}>Cleffy</span>
);

const Nav = () => (
    <nav aria-label="Main" className="safe-landing-nav flex items-center justify-between gap-3 pb-4 sm:gap-4 sm:pb-6">
        <span className="inline-flex items-center gap-3 font-display text-[26px] font-semibold tracking-[-0.01em] text-paper sm:text-[28px]">
            Cleffy
            <span aria-hidden="true" className="hidden h-[3px] w-10 bg-ink-rule sm:block" />
        </span>
        <div className="flex items-center gap-4 sm:gap-5">
            <PlansLink className={`hidden sm:inline-flex ${INK_LINK}`} />
            {/* Students arrive here too, sent by a teacher, and their door is
                not the one marked "Log in": it takes a username, not an
                account. A phone has no room for it here, so there it moves
                under the hero's buttons, and the hero's gaps are tighter on a
                phone so it still shows on a 390 x 844 first screen. */}
            <Link to="/student" className={`hidden sm:inline-flex ${INK_LINK}`}>
                Student sign in
            </Link>
            <Link
                to="/login"
                className="inline-flex min-h-11 items-center whitespace-nowrap text-[15px] font-medium text-paper hover:underline"
            >
                Log in
            </Link>
            <StartFreeLink className={NAV_START_BUTTON} />
        </div>
    </nav>
);

const priceLine = () => {
    const currency = currencyForCountry(initialBillingCountry());
    return `${lowestMonthlyPrice(currency)}/month${TAX_INCLUSIVE[currency] ? ', VAT incl.' : ' + tax'}`;
};

const Hero = () => (
    <header className="ink-band">
        <div className="safe-landing-gutter mx-auto w-full max-w-6xl">
            <Nav />
            <section
                aria-labelledby="hero-title"
                className="ink-hero-grid pt-3 pb-12 sm:pt-5 lg:pt-[72px] lg:pb-[104px]"
            >
                <div className="ink-hero-copy">
                    <p
                        className="ink-rise-now flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-base font-semibold text-stone-300 sm:gap-x-3 sm:gap-y-1 sm:text-[19px]"
                        style={rise(0)}
                    >
                        Sheet music that syncs.{' '}
                        <span className="inline-block -rotate-5 font-hand text-[28px] leading-[0.8] font-bold text-ink-hand sm:text-[34px]">
                            (finally)
                        </span>
                    </p>
                    <h1
                        id="hero-title"
                        className="ink-rise-now mt-3.5 font-display text-[66px] leading-[0.98] font-semibold tracking-[-0.025em] text-paper sm:mt-5 sm:text-[clamp(60px,7.6vw,112px)]"
                        style={rise(1)}
                    >
                        <span className="block">Draw on</span> <em className="block">Für Elise.</em>
                    </h1>
                    <p
                        className="ink-rise-now mt-3.5 text-lg leading-[1.45] text-stone-300 sm:mt-7 sm:text-[21px] sm:leading-normal"
                        style={rise(2)}
                    >
                        Right now, in your browser. No account, no download.
                    </p>
                </div>
                <div className="ink-hero-score ink-rise-now mt-5 sm:mt-[26px] lg:mt-0" style={rise(3)}>
                    <HeroDemo />
                    <div
                        aria-hidden="true"
                        className="mt-1.5 mr-3 flex items-start justify-end gap-1 text-ink-hand sm:mt-2.5 sm:mr-6 sm:gap-1.5"
                    >
                        <svg
                            viewBox="0 0 90 60"
                            className="h-[38px] w-14 sm:h-[54px] sm:w-20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3.25"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M 80 52 C 50 54, 22 40, 18 10" />
                            <path d="M 6 22 L 18 8 L 32 20" />
                        </svg>
                        <span className="mt-2.5 inline-block -rotate-4 font-hand text-[34px] leading-none font-bold sm:mt-3.5 sm:text-[46px]">
                            your turn
                        </span>
                    </div>
                </div>
                <div className="ink-hero-actions ink-rise-now mt-3 sm:mt-[18px] lg:mt-9" style={rise(3)}>
                    <div className={BUTTON_ROW}>
                        <TryLink className={TRY_BUTTON}>
                            <PenIcon />
                            Try it now
                        </TryLink>
                        <StartFreeLink className={START_BUTTON} />
                    </div>
                    {/* Keep in sync with FREE_LIMITS.cloud_scores (billing/entitlementsService.ts)
                        and priceFor() (billing/pricing.ts). */}
                    <p className="mt-2.5 text-center text-[13px] leading-normal text-stone-400 sm:mt-4 sm:text-left sm:text-sm">
                        Free for 3 cloud scores · plans from {priceLine()}
                    </p>
                    <p className="text-center sm:hidden">
                        <Link to="/student" className={`inline-flex ${INK_LINK}`}>
                            Student sign in
                        </Link>
                    </p>
                </div>
            </section>
        </div>
    </header>
);

const Audiences = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.2);
    return (
        <section
            ref={ref}
            aria-label="Who it is for"
            className={`grid gap-7 py-11 md:grid-cols-3 md:gap-8 md:pt-14 md:pb-16${inView ? ' is-revealed' : ''}`}
        >
            {AUDIENCES.map((audience, i) => (
                <div key={audience.label} className="ink-rise" style={rise(i)}>
                    <p className="text-xs font-semibold tracking-[0.08em] text-stone-600 uppercase md:text-[13px]">
                        {audience.label}
                    </p>
                    <p className="mt-2 font-display text-2xl leading-[1.22] font-semibold tracking-[-0.01em] md:mt-2.5 md:text-[26px]">
                        {audience.line}
                    </p>
                </div>
            ))}
        </section>
    );
};

/** "Everything’s shared now.": three ticks and a cross, then what Cleffy changes. */
const TheGap = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.2);
    return (
        <section
            ref={ref}
            aria-labelledby="gap-title"
            className={`flex flex-col gap-9 border-t border-ink/10 pt-[52px] pb-14 lg:flex-row lg:items-start lg:gap-20 lg:pt-20 lg:pb-[88px]${
                inView ? ' is-revealed is-inview' : ''
            }`}
        >
            <div className="min-w-0 lg:flex-[1.2_1_0%]">
                <h2
                    id="gap-title"
                    className="ink-rise font-display text-[42px] leading-[1.02] font-semibold tracking-[-0.02em] lg:text-[clamp(40px,4.4vw,62px)]"
                >
                    Everything’s shared now.
                </h2>
                <ul className="mt-5 lg:mt-7">
                    {SHARED.map((row, i) => (
                        <li
                            key={row.label}
                            className="ink-rise flex min-h-14 items-center justify-between gap-3 border-b-[1.5px] border-ink/12 text-[23px] font-semibold lg:min-h-[68px] lg:gap-4 lg:text-[30px]"
                            style={rise(i + 1)}
                        >
                            <span>
                                {row.label}
                                <span className="sr-only">: shared</span>
                            </span>
                            <svg
                                viewBox="0 0 80 60"
                                className="h-7 w-[38px] flex-none lg:h-9 lg:w-12"
                                aria-hidden="true"
                            >
                                <path
                                    className="hero-ink stroke-tick [stroke-width:6] lg:[stroke-width:5]"
                                    style={draw(0.35 + i * 0.15, 0.45)}
                                    pathLength={100}
                                    d={row.tick}
                                    fill="none"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </li>
                    ))}
                    <li
                        className="ink-rise flex min-h-[62px] items-center justify-between gap-3 text-[26px] font-bold text-danger lg:min-h-[76px] lg:gap-4 lg:text-[34px]"
                        style={rise(4)}
                    >
                        <span>
                            Your sheet music
                            <span className="sr-only">: not shared</span>
                        </span>
                        <svg
                            viewBox="0 0 80 80"
                            className="h-[34px] w-[34px] flex-none lg:h-11 lg:w-11"
                            aria-hidden="true"
                        >
                            <path
                                className="hero-ink [stroke-width:9] lg:[stroke-width:8]"
                                style={draw(0.9, 0.5)}
                                pathLength={100}
                                d="M 12 10 C 30 30, 50 52, 70 72 M 70 10 C 52 30, 32 50, 12 72"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                            />
                        </svg>
                    </li>
                </ul>
                <p
                    className="ink-rise mt-0 ml-2 inline-block -rotate-3 font-hand text-[30px] leading-[1.1] font-bold text-danger lg:mt-0.5 lg:ml-3 lg:text-[38px]"
                    style={rise(5)}
                >
                    still a photocopy in a folder
                </p>
            </div>
            <div className="min-w-0 lg:flex-[1_1_0%] lg:pt-3">
                <h3
                    className="ink-rise font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.015em] italic lg:text-[40px]"
                    style={rise(2)}
                >
                    Until now.
                </h3>
                <p
                    className="ink-rise mt-3.5 text-lg leading-normal text-stone-700 lg:mt-5 lg:text-xl lg:leading-[1.55]"
                    style={rise(3)}
                >
                    Cleffy puts the score online. Your teacher, your section and your own devices all open the same
                    page, and every mark lands on it live.
                </p>
                {SHOW_DOCS_COMPARISON ? (
                    <p
                        className="ink-rise mt-3.5 text-base leading-normal text-stone-600 lg:mt-5 lg:text-[17px] lg:leading-[1.55]"
                        style={rise(4)}
                    >
                        If you’ve used Google Docs, you already know how it works: one link, and everyone’s marks appear
                        as they’re made.
                    </p>
                ) : null}
                <p
                    className="ink-rise mt-7 border-t border-ink/10 pt-6 font-display text-[22px] leading-[1.3] font-semibold tracking-[-0.01em] text-stone-600 lg:text-2xl"
                    style={rise(5)}
                >
                    Photocopy. Pencil. Eraser. Repeat.{' '}
                    <span className="ink-highlighter text-ink" style={{ '--d': '0.8s' } as CSSProperties}>
                        Or: one link.
                    </span>
                </p>
            </div>
        </section>
    );
};

const HowItStarts = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.2);
    return (
        <section
            ref={ref}
            aria-labelledby="how-title"
            className={`border-t border-ink/10 pt-12 pb-[52px] lg:pt-16 lg:pb-20${inView ? ' is-revealed' : ''}`}
        >
            <h2
                id="how-title"
                className="ink-rise font-display text-[30px] font-semibold tracking-[-0.015em] lg:text-[34px]"
            >
                How it starts
            </h2>
            <ol className="mt-6 grid gap-6 md:grid-cols-3 md:gap-8 lg:mt-8">
                {STEPS.map((step, i) => (
                    <li key={step.mark} className="ink-rise flex gap-3.5 lg:gap-4" style={rise(i + 1)}>
                        <span
                            aria-hidden="true"
                            className="flex h-[38px] w-[38px] flex-none items-center justify-center border-[1.5px] border-ink font-display text-[19px] font-semibold lg:h-10 lg:w-10 lg:text-xl"
                        >
                            {step.mark}
                        </span>
                        <div>
                            <h3 className="text-[17px] font-semibold lg:text-lg">{step.title}</h3>
                            <p className="mt-1 text-base leading-normal text-stone-600 lg:mt-1.5 lg:leading-[1.55]">
                                {step.body}
                            </p>
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
};

const WhatCleffyDoes = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.2);
    return (
        <section
            ref={ref}
            aria-labelledby="features-title"
            className={`py-12 lg:py-[72px]${inView ? ' is-revealed' : ''}`}
        >
            <h2
                id="features-title"
                className="ink-rise text-xs font-semibold tracking-[0.08em] text-stone-600 uppercase lg:text-[13px]"
            >
                What Cleffy does
            </h2>
            <ul className="mt-[22px] grid gap-[22px] sm:grid-cols-2 sm:gap-x-8 sm:gap-y-9 lg:mt-7 lg:grid-cols-5">
                {FEATURES.map((feature, i) => (
                    <li key={feature.title} className="ink-rise flex gap-3.5 sm:block" style={rise(i + 1)}>
                        <svg
                            viewBox="0 0 24 24"
                            className="mt-0.5 h-6 w-6 flex-none text-accent sm:mt-0 sm:h-[26px] sm:w-[26px]"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <path d={feature.icon} />
                        </svg>
                        <div>
                            <h3 className="text-[17px] font-semibold sm:mt-3">{feature.title}</h3>
                            <p className="mt-[3px] text-base leading-normal text-stone-600 sm:mt-1.5 sm:text-[15px] sm:leading-[1.55]">
                                {feature.body}
                            </p>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
};

const Closing = () => {
    const { ref, inView } = useInViewOnce<HTMLElement>(0.25);
    return (
        <section
            ref={ref}
            aria-labelledby="closing-title"
            className={`pt-[68px] pb-[60px] text-center lg:pt-[104px] lg:pb-24${inView ? ' is-revealed is-inview' : ''}`}
        >
            <h2
                id="closing-title"
                className="ink-rise font-display text-[72px] leading-none font-semibold tracking-[-0.025em] italic lg:text-[clamp(64px,8vw,120px)]"
            >
                <span className="relative inline-block">
                    Your turn.
                    <svg
                        viewBox="0 0 300 24"
                        aria-hidden="true"
                        className="absolute top-[96%] left-[2%] h-auto w-[96%] overflow-visible"
                    >
                        <path
                            className="hero-ink stroke-ink-hand"
                            style={draw(0.35, 0.7)}
                            pathLength={100}
                            d="M 4 16 C 70 4, 150 22, 296 8"
                            fill="none"
                            strokeWidth="3.4"
                            strokeLinecap="round"
                        />
                    </svg>
                </span>
            </h2>
            <p
                className="ink-rise mx-auto mt-[30px] max-w-[520px] text-lg leading-normal text-stone-300 lg:mt-10 lg:text-xl lg:leading-[1.55]"
                style={rise(1)}
            >
                Draw on Für Elise in your browser, or start a free library of your own.
            </p>
            <div className={`ink-rise mt-[26px] sm:justify-center lg:mt-9 ${BUTTON_ROW}`} style={rise(2)}>
                <TryLink className={TRY_BUTTON}>Try it now</TryLink>
                <StartFreeLink className={START_BUTTON} />
            </div>
        </section>
    );
};

const InkFooter = () => (
    <footer>
        <div className="flex flex-col gap-3.5 border-t border-paper/14 pt-6 pb-3 lg:flex-row lg:flex-wrap lg:items-baseline lg:justify-between lg:gap-x-8 lg:gap-y-3 lg:pt-7">
            <p className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
                <span className="font-display text-[22px] font-semibold">Cleffy</span>
                <span className="text-[13px] text-stone-400">Real-time collaborative sheet music annotation</span>
            </p>
            <div className="ink-footer-links flex flex-col items-start gap-x-[18px] gap-y-2 sm:flex-row sm:flex-wrap sm:items-center">
                <LegalLinks withContact />
                <CancelSubscriptionLink />
                <LocalOpenControl label="Open a score locally" subtle />
            </div>
        </div>
        {SHOW_DOCS_COMPARISON ? (
            <p className="pb-10 text-xs leading-normal text-stone-400">
                Google Docs is a trademark of Google LLC. Cleffy is not affiliated with or endorsed by Google.
            </p>
        ) : (
            <div className="pb-10" />
        )}
    </footer>
);

/**
 * Cloud landing ("Ink"): an ink hero whose headline is the demo, then paper
 * and ink bands. "Try it now" (/try) is the filled button in the hero and the
 * closing band, and the score is a third way in; "Start free" is the outline
 * beside it and the nav's button.
 */
const CloudLanding = () => {
    useInkChrome();
    return (
        <main className="ink-landing min-h-full">
            <Hero />
            <div className="bg-paper text-ink">
                <div className="safe-landing-gutter mx-auto w-full max-w-6xl">
                    <Audiences />
                    <TheGap />
                    <HowItStarts />
                </div>
            </div>
            <LiveInkBand />
            <div className="bg-paper text-ink">
                <div className="safe-landing-gutter mx-auto w-full max-w-6xl">
                    <ProductShowcase />
                    <WhatCleffyDoes />
                    <PlansBand />
                </div>
            </div>
            <div className="ink-plain">
                <div className="safe-landing-gutter mx-auto w-full max-w-6xl">
                    <Closing />
                    <InkFooter />
                </div>
            </div>
        </main>
    );
};

const PaperFooter = () => (
    <footer className="border-t border-line py-8">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="flex items-baseline gap-3">
                <Wordmark className="text-lg" />
                <span className="text-xs text-stone-500">Real-time collaborative sheet music annotation</span>
            </p>
            <LocalOpenControl label="Open a score locally" subtle />
        </div>
        <LegalLinks withContact className="mt-4 justify-center sm:justify-start" />
        <CancelSubscriptionLink className="mt-3 text-center sm:text-left" />
    </footer>
);

/** Local-only fallback when Supabase isn't configured: the paper layout, with the same score. */
const LocalLanding = () => (
    <main className="landing-page min-h-full">
        <div className="safe-landing-gutter mx-auto flex min-h-full w-full max-w-6xl flex-col">
            <nav aria-label="Main" className="safe-landing-nav flex items-center justify-between">
                <Wordmark />
            </nav>
            <section className="landing-hero flex flex-1 flex-col justify-center gap-12 py-14 lg:grid lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-center lg:gap-16">
                <div className="text-center lg:text-left">
                    <h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                        Annotate scores on this device
                    </h1>
                    <div className="landing-rule mx-auto lg:mx-0" aria-hidden="true" />
                    <p className="mx-auto mt-5 max-w-sm text-[0.95rem] leading-relaxed text-stone-600 lg:mx-0">
                        Cloud sync is not configured. You can still open and annotate PDFs locally.
                    </p>
                    <div className="mt-8 flex justify-center lg:justify-start">
                        <LocalOpenControl label="Open a score" />
                    </div>
                </div>
                <HeroDemo />
            </section>
            <PaperFooter />
        </div>
    </main>
);

export const LandingPage = () => {
    if (!isSupabaseConfigured()) {
        return <LocalLanding />;
    }
    return (
        <RequireGuest>
            <CloudLanding />
        </RequireGuest>
    );
};
