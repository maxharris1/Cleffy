import type { InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';

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
                <Link to="/" className="landing-brand font-display text-3xl font-semibold leading-none tracking-tight">
                    Cleffy
                </Link>
                <div className="landing-rule mx-auto" aria-hidden="true" />
                <h1 className="mt-6 text-lg font-medium tracking-tight text-stone-800">{title}</h1>
                {subtitle ? <p className="mt-2 text-sm leading-relaxed text-stone-600">{subtitle}</p> : null}
                {children ? <div className="mt-8 text-left">{children}</div> : null}
            </div>
        </main>
    );
};

export const BrandLoading = () => (
    <main className="landing-page flex min-h-full items-center justify-center">
        <p className="animate-pulse text-stone-500">Loading…</p>
    </main>
);

export const brandFieldClassName =
    'landing-input mt-1.5 w-full rounded-xl border border-stone-300/90 bg-white/70 px-3.5 py-3 text-stone-900 outline-none transition placeholder:text-stone-400';

export const brandLabelClassName = 'block text-xs font-medium uppercase tracking-[0.08em] text-stone-500';

export const brandPrimaryButtonClassName =
    'landing-cta mt-4 w-full rounded-xl px-4 py-3 font-medium text-white disabled:opacity-50';

export const brandLinkClassName =
    'text-sm text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-900';

interface BrandTextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
    id: string;
    label: string;
    spaced?: boolean;
}

export const BrandTextField = ({ id, label, spaced = false, ...inputProps }: BrandTextFieldProps) => (
    <>
        <label htmlFor={id} className={`${brandLabelClassName}${spaced ? ' mt-4' : ''}`}>
            {label}
        </label>
        <input id={id} className={brandFieldClassName} {...inputProps} />
    </>
);
