import '@/features/marketing/handwriting.css';

import { Link } from 'react-router';

import { LegalLinks } from '@/features/legal/LegalLinks';
import { buttonClassName } from '@/ui/classNames';
import { Wordmark } from '@/ui/Wordmark';

const STAFF_LINE = 'rgb(247 245 239 / 0.85)';

/** Five 2px lines 22px apart, as Flow-NotFound draws them. */
const STAFF_LINES = `linear-gradient(to bottom, ${STAFF_LINE} 0 2px, transparent 2px 24px, ${STAFF_LINE} 24px 26px, transparent 26px 48px, ${STAFF_LINE} 48px 50px, transparent 50px 72px, ${STAFF_LINE} 72px 74px, transparent 74px 96px, ${STAFF_LINE} 96px 98px)`;

/** Catch-all 404 — the PWA navigateFallback lands unknown URLs on the SPA, which renders this. */
export const NotFoundPage = () => (
    <main className="chrome-ink flex min-h-full flex-col bg-ink pt-[max(36px,var(--safe-top))] pr-[max(24px,var(--safe-right))] pb-[max(36px,var(--safe-bottom))] pl-[max(24px,var(--safe-left))] text-paper sm:pr-[max(40px,var(--safe-right))] sm:pl-[max(40px,var(--safe-left))]">
        <div>
            <Link
                to="/"
                className="inline-flex text-[30px] leading-none pointer-coarse:-my-[7px] pointer-coarse:py-[7px]"
            >
                <Wordmark tone="ink" />
            </Link>
        </div>
        <div className="brand-enter mx-auto my-auto w-full max-w-[640px] py-10 text-center">
            <div
                aria-hidden="true"
                className="relative mx-auto h-[98px] w-[min(520px,100%)]"
                style={{ backgroundImage: STAFF_LINES }}
            >
                <span className="absolute top-[26px] left-1/2 -ml-[22px] h-3 w-11 bg-paper" />
            </div>
            <h1 className="display-opsz mt-11 font-display text-[clamp(80px,28vw,116px)] leading-none font-semibold tracking-[-0.02em] text-paper">
                <em className="shadow-[inset_0_-0.09em_0_var(--color-ink),inset_0_-0.15em_0_var(--color-ink-hand)]">
                    Tacet.
                </em>
            </h1>
            <p className="mt-[22px] text-[19px] leading-normal text-pretty text-on-ink-muted">
                This page is silent — there’s nothing at this address.
            </p>
            <div className="mt-[30px] flex flex-wrap justify-center gap-3">
                <Link to="/library" className={buttonClassName('inkPrimary')}>
                    Go to your library
                </Link>
                <Link to="/" className={buttonClassName('inkOutline')}>
                    Back to home
                </Link>
            </div>
            <p className="mt-7">
                <span className="inline-block -rotate-2 font-hand text-[28px] leading-[1.1] font-bold text-ink-hand">
                    a whole bar of rest
                </span>
            </p>
        </div>
        <LegalLinks tone="ink" />
    </main>
);
