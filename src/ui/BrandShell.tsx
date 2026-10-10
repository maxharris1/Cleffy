import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { LoadingText } from '@/ui/Loading';

interface BrandShellProps {
    title: string;
    subtitle?: string;
    children?: ReactNode;
}

const BRAND_CLASS = 'landing-brand font-display text-3xl font-semibold leading-none';

const BrandFrame = ({ brand, title, subtitle, children }: BrandShellProps & { brand: ReactNode }) => (
    <main className="landing-page safe-brand-shell flex min-h-full flex-col items-center justify-center">
        <div className="landing-hero w-full max-w-sm text-center">
            {brand}
            <div className="landing-rule mx-auto" aria-hidden="true" />
            <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-stone-800">{title}</h1>
            {subtitle ? <p className="mt-2 text-sm leading-relaxed text-stone-600">{subtitle}</p> : null}
            {children ? <div className="mt-8 text-left">{children}</div> : null}
        </div>
    </main>
);

/** Cleffy brand frame used by auth, join, and empty/error surfaces. */
export const BrandShell = (props: BrandShellProps) => (
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
export const StaticBrandShell = (props: BrandShellProps) => (
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
    <main className="landing-page flex min-h-full items-center justify-center pt-[var(--safe-top)]">
        <LoadingText>Loading…</LoadingText>
    </main>
);
