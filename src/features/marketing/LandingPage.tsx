import { Link } from 'react-router';

import { RequireGuest } from '@/features/auth/AuthGates';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { HeroDemo } from '@/features/marketing/HeroDemo';
import { isSupabaseConfigured } from '@/lib/supabase';
import { buttonClassName, linkClassName } from '@/ui/classNames';

const STEPS = [
    {
        mark: 'A',
        title: 'Add a score',
        body: 'Upload a PDF, or pull one from IMSLP’s public-domain library without leaving the app.',
    },
    {
        mark: 'B',
        title: 'Share the link',
        body: 'Students open it in any browser and just type a name — no accounts, no installs.',
    },
    {
        mark: 'C',
        title: 'Mark it up together',
        body: 'Ink streams live as everyone draws. Any editor can erase or refine any mark.',
    },
] as const;

const FEATURES = [
    { title: 'Live ink', body: 'Strokes stream to everyone as they’re drawn, not after.' },
    { title: 'Works offline', body: 'Annotate anywhere; changes sync when you’re back.' },
    { title: 'IMSLP built in', body: 'Search public-domain scores and add them straight to your library.' },
    { title: 'Export & share', body: 'Send a page as a photo, or a flattened PDF of the whole score.' },
    { title: 'The PDF stays pristine', body: 'Marks live on top — the original file is never modified.' },
] as const;

const Wordmark = ({ className = 'text-2xl' }: { className?: string }) => (
    <span className={`landing-brand font-display font-semibold ${className}`}>Cleffy</span>
);

const Footer = () => (
    <footer className="border-t border-line py-8">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="flex items-baseline gap-3">
                <Wordmark className="text-lg" />
                <span className="text-xs text-stone-500">Real-time collaborative sheet music annotation</span>
            </p>
            <LocalOpenControl label="Open a score locally" subtle />
        </div>
    </footer>
);

/** Cloud landing: top bar, self-annotating hero, how-it-works, features, CTA. */
const CloudLanding = () => (
    <main className="landing-page min-h-full">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-10">
            <nav aria-label="Main" className="flex items-center justify-between pt-6">
                <Wordmark />
                <div className="flex items-center gap-4">
                    {/* Students arrive here too, sent by a teacher, and their door
                        is not the one marked "Log in" — it takes a username, not
                        an account. Quiet, because most visitors are teachers. */}
                    <Link to="/student" className={linkClassName}>
                        Student sign in
                    </Link>
                    <Link to="/login" className={buttonClassName('secondary', 'sm')}>
                        Log in
                    </Link>
                </div>
            </nav>

            <section className="landing-hero flex flex-col gap-12 py-14 lg:grid lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:py-20">
                <div className="text-center lg:text-left">
                    <h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                        Annotate scores <em>together</em>, in real time
                    </h1>
                    <div className="landing-rule mx-auto lg:mx-0" aria-hidden="true" />
                    <p className="mx-auto mt-5 max-w-sm text-[0.95rem] leading-relaxed text-stone-600 lg:mx-0">
                        Upload a score, share one link, and mark it up live with your students or ensemble — they join
                        in the browser, no account needed.
                    </p>
                    <div className="mx-auto mt-8 flex w-full max-w-sm flex-col items-center gap-4 lg:mx-0 lg:items-start">
                        <Link to="/register" className={buttonClassName('primary')}>
                            Create account
                        </Link>
                        <LocalOpenControl label="Or open a PDF locally — no account" subtle />
                    </div>
                </div>
                <HeroDemo />
            </section>

            <section aria-labelledby="how-title" className="border-t border-line py-14 lg:py-16">
                <h2 id="how-title" className="font-display text-2xl font-semibold tracking-tight text-ink">
                    How a lesson starts
                </h2>
                <ol className="mt-8 grid gap-8 sm:grid-cols-3">
                    {STEPS.map((step) => (
                        <li key={step.mark} className="flex gap-4">
                            <span
                                aria-hidden="true"
                                className="flex h-9 w-9 shrink-0 items-center justify-center border-[1.5px] border-ink font-display text-lg font-semibold text-ink"
                            >
                                {step.mark}
                            </span>
                            <div>
                                <h3 className="font-medium text-stone-800">{step.title}</h3>
                                <p className="mt-1 text-sm leading-relaxed text-stone-600">{step.body}</p>
                            </div>
                        </li>
                    ))}
                </ol>
            </section>

            <section aria-labelledby="features-title" className="border-t border-line py-14 lg:py-16">
                <h2 id="features-title" className="sr-only">
                    What Cleffy does
                </h2>
                <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-5">
                    {FEATURES.map((feature) => (
                        <div key={feature.title}>
                            <dt className="text-sm font-medium text-stone-800">{feature.title}</dt>
                            <dd className="mt-1 text-sm leading-relaxed text-stone-600">{feature.body}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section className="border-t border-line py-16 text-center">
                <h2 className="font-display text-3xl font-semibold tracking-tight text-ink">
                    Set up before your next lesson
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-stone-600">
                    Create a free account, add a score, and send one link. Your students are ready in the time it takes
                    to tune.
                </p>
                <div className="mt-7 flex justify-center">
                    <Link to="/register" className={buttonClassName('primary')}>
                        Create account
                    </Link>
                </div>
            </section>

            <Footer />
        </div>
    </main>
);

/** Local-only fallback when Supabase isn't configured. */
const LocalLanding = () => (
    <main className="landing-page min-h-full">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-6 lg:px-10">
            <nav aria-label="Main" className="flex items-center justify-between pt-6">
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
            <Footer />
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
