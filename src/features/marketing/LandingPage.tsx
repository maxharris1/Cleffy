import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { RequireGuest } from '@/features/auth/AuthGates';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { isSupabaseConfigured } from '@/lib/supabase';
import { buttonClassName } from '@/ui/classNames';

const CollabDemo = () => (
    <picture className="landing-demo block w-full">
        <source srcSet="/marketing/landing-collab-demo.webp" type="image/webp" />
        <img
            src="/marketing/landing-collab-demo.jpg"
            alt="A shared score with live cursors from Ms. Torres, Alex, and Sam annotating together"
            width={1600}
            height={1066}
            className="h-auto w-full object-cover object-center"
            decoding="async"
            fetchPriority="high"
        />
    </picture>
);

interface LandingHeroProps {
    headline: string;
    body: string;
    actions: ReactNode;
}

const LandingHero = ({ headline, body, actions }: LandingHeroProps) => (
    <main className="landing-page min-h-full">
        <div className="landing-hero mx-auto flex min-h-full w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-center lg:gap-14 lg:px-10 lg:py-16">
            <div className="text-center lg:text-left">
                <p className="landing-brand font-display text-[2.5rem] font-semibold leading-[1.1] sm:text-5xl">
                    Cleffy
                </p>
                <div className="landing-rule mx-auto lg:mx-0" aria-hidden="true" />
                <h1 className="mt-6 text-lg font-medium tracking-tight text-stone-800 sm:text-xl">{headline}</h1>
                <p className="mx-auto mt-3 max-w-sm text-[0.95rem] leading-relaxed text-stone-600 lg:mx-0">{body}</p>
                {actions}
            </div>

            <div className="landing-demo-frame min-w-0 overflow-hidden rounded-sm">
                <CollabDemo />
            </div>
        </div>
    </main>
);

export const LandingPage = () => {
    if (!isSupabaseConfigured()) {
        return (
            <LandingHero
                headline="Annotate scores on this device"
                body="Cloud sync is not configured. You can still open and annotate PDFs locally."
                actions={
                    <div className="mt-8 flex justify-center lg:justify-start">
                        <LocalOpenControl label="Open a PDF" />
                    </div>
                }
            />
        );
    }
    return (
        <RequireGuest>
            <LandingHero
                headline="Annotate scores together, in real time"
                body="Create an account to upload and share. Students join through a link — no account needed."
                actions={
                    <>
                        <div className="mx-auto mt-8 flex w-full max-w-sm flex-col gap-3 sm:flex-row sm:justify-center lg:mx-0 lg:justify-start">
                            <Link to="/register" className={buttonClassName('primary')}>
                                Create account
                            </Link>
                            <Link to="/login" className={buttonClassName('secondary')}>
                                Log in
                            </Link>
                        </div>
                        <div className="mt-7">
                            <LocalOpenControl label="Or open a PDF locally — no account" subtle />
                        </div>
                    </>
                }
            />
        </RequireGuest>
    );
};
