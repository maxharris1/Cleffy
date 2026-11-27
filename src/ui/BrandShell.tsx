import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { LoadingText } from '@/ui/Loading';
import { Wordmark } from '@/ui/Wordmark';

interface BrandShellProps {
    title: string;
    subtitle?: string;
    children?: ReactNode;
    /** Decoration for the ink half. Given, the page splits in two; the ink half is hidden below 1024px. */
    art?: ReactNode;
    /** Pinned to the bottom of the paper half in the split layout; after the content otherwise. */
    footer?: ReactNode;
}

const BRAND_CLASS = 'landing-brand font-display text-3xl font-semibold leading-none';

const BrandFrame = ({ brand, title, subtitle, children, footer }: BrandShellProps & { brand: ReactNode }) => (
    <main className="paper-page safe-brand-shell flex min-h-full flex-col items-center justify-center">
        <div className="brand-enter w-full max-w-sm text-center">
            {brand}
            <div className="brand-rule mx-auto" aria-hidden="true" />
            <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-stone-800">{title}</h1>
            {subtitle ? (
                <p className="mt-2 text-sm leading-relaxed text-stone-600 [overflow-wrap:anywhere]">{subtitle}</p>
            ) : null}
            {children ? <div className="mt-8 text-left">{children}</div> : null}
            {footer}
        </div>
    </main>
);

const SplitFrame = ({ title, subtitle, children, art, footer }: BrandShellProps) => (
    <div className="paper-page flex min-h-full">
        <main className="safe-split-pane flex min-w-0 flex-1 flex-col lg:flex-[1_1_420px]">
            <div>
                <Link
                    to="/"
                    className="inline-flex text-[30px] leading-none pointer-coarse:-my-[7px] pointer-coarse:py-[7px]"
                >
                    <Wordmark />
                </Link>
            </div>
            <div className="brand-enter mx-auto my-auto w-full max-w-[400px] py-10 lg:mx-0">
                <h1 className="display-opsz font-display text-[44px] leading-[1.02] font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[60px]">
                    {title}
                </h1>
                {subtitle ? (
                    <p className="mt-3.5 text-[17px] leading-normal text-pretty text-stone-600 [overflow-wrap:anywhere]">
                        {subtitle}
                    </p>
                ) : null}
                {children ? <div className="mt-[30px]">{children}</div> : null}
            </div>
            {footer}
        </main>
        <aside
            aria-hidden="true"
            inert
            className="hidden min-w-0 flex-[1.15_1_460px] flex-col items-center justify-center bg-ink px-14 py-16 text-paper select-none lg:flex"
        >
            {art}
        </aside>
    </div>
);

/** Cleffy brand frame used by auth, join, and empty/error surfaces. */
export const BrandShell = (props: BrandShellProps) =>
    props.art ? (
        <SplitFrame {...props} />
    ) : (
        <BrandFrame
            {...props}
            brand={
                <Link to="/" className={BRAND_CLASS}>
                    Cleffy
                </Link>
            }
        />
    );

/**
 * The same frame with no router in it, for the crash screen. The error
 * boundary sits above BrowserRouter so it catches the router's own failures,
 * and a `<Link>` there throws "useContext(...) is null" while the screen is
 * drawn — a crash screen that crashes is a blank page. A plain anchor is also
 * the right way out of a broken page: a full load.
 */
export const StaticBrandShell = (props: Omit<BrandShellProps, 'art'>) => (
    <BrandFrame
        {...props}
        brand={
            <a href="/" className={BRAND_CLASS}>
                Cleffy
            </a>
        }
    />
);

export const BrandLoading = () => (
    <main className="paper-page flex min-h-full items-center justify-center pt-[var(--safe-top)]">
        <LoadingText>Loading…</LoadingText>
    </main>
);
