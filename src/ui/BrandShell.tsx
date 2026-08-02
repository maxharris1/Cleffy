import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { LoadingText } from '@/ui/Loading';

interface BrandShellProps {
    title: string;
    subtitle?: string;
    children?: ReactNode;
}

/** Cleffy brand frame used by auth, join, and empty/error surfaces. */
export const BrandShell = ({ title, subtitle, children }: BrandShellProps) => {
    return (
        <main className="landing-page flex min-h-full flex-col items-center justify-center px-6 py-12">
            <div className="landing-hero w-full max-w-sm text-center">
                <Link to="/" className="landing-brand font-display text-3xl font-semibold leading-none">
                    Cleffy
                </Link>
                <div className="landing-rule mx-auto" aria-hidden="true" />
                <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-stone-800">{title}</h1>
                {subtitle ? <p className="mt-2 text-sm leading-relaxed text-stone-600">{subtitle}</p> : null}
                {children ? <div className="mt-8 text-left">{children}</div> : null}
            </div>
        </main>
    );
};

export const BrandLoading = () => (
    <main className="landing-page flex min-h-full items-center justify-center">
        <LoadingText>Loading…</LoadingText>
    </main>
);
