import { useState } from 'react';
import { Link } from 'react-router';

import { passwordProblem, passwordProblemMessage } from '../../../supabase/functions/_shared/passwordPolicy';
import { confirmGuestEmailUpgrade, GuestUpgradeError, startGuestEmailUpgrade } from '@/features/auth/guestUpgrade';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
import { CloseIcon } from '@/ui/icons';

type BannerState = 'collapsed' | 'details' | 'code' | 'done' | 'signInNeeded' | 'dismissed';

const INPUT_CLASS =
    'min-w-40 flex-1 rounded border border-amber-300 bg-white px-2 py-1 outline-none focus:border-amber-500';
const PRIMARY_CLASS = 'rounded bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-600 disabled:opacity-60';
const LINK_BUTTON_CLASS = 'text-amber-800 underline disabled:opacity-60';

const isPlausibleEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Anonymous identities live in this browser's storage only — evicted storage
 * silently orphans a guest's work. Nudge guests to attach an email and a
 * password (same user id, memberships and annotations untouched — plan §auth).
 *
 * The address is PROVEN before it is attached: a code is mailed to it and has
 * to come back (guestUpgrade.ts). Handing the address straight to the auth
 * client's updateUser, as this banner used to, let a guest claim anybody's
 * address, because the auth server auto-confirms email changes while sign-up
 * confirmation is off.
 *
 * Rendered for every viewer session; it shows itself to guests, and stays up
 * after a successful attach (when the session is no longer a guest's) to say
 * how to sign in next time. "Saved" waits for the registered session the
 * attach has to be followed by (guestUpgrade.ts): if that sign-in fails, the
 * guest's old session is already gone server-side, so the banner says the
 * email is saved and asks them to sign in with it instead.
 */
export const UpgradeBanner = ({ isGuest }: { isGuest: boolean }) => {
    const [state, setState] = useState<BannerState>('collapsed');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);
    const [busy, setBusy] = useState(false);
    /**
     * A Turnstile token for whichever step this banner is on, and a round that
     * forces a fresh challenge.
     *
     * Both steps need one, for different servers: "email me a code" is
     * verified by guest-email-start itself (it is our own send path, the one
     * abuse path that is entirely ours), and "save my work" ends in GoTrue's
     * password grant, which the project-wide captcha setting covers. A token
     * is single-use, so the round is bumped on every step change and every
     * failure rather than the spent one being replayed.
     *
     * Null, and no widget at all, on a build without `VITE_TURNSTILE_SITE_KEY`
     * — which is every build today, so this banner is unchanged until the keys
     * are set.
     */
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    const [captchaRound, setCaptchaRound] = useState(0);
    const captchaRequired = isTurnstileEnabled();

    if (state === 'dismissed' || (!isGuest && state !== 'done' && state !== 'signInNeeded')) {
        return null;
    }

    /** Move to another step with a clean slate: no spent token, a new challenge. */
    const goTo = (next: BannerState) => {
        setError(null);
        setCaptchaToken(null);
        setCaptchaRound((round) => round + 1);
        setState(next);
    };

    const freshChallenge = () => {
        setCaptchaToken(null);
        setCaptchaRound((round) => round + 1);
    };

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (err) {
            setError({
                message: err instanceof Error ? err.message : 'Something went wrong. Try again.',
                signIn: err instanceof GuestUpgradeError && err.code === 'email_in_use',
            });
            if (captchaRequired) {
                freshChallenge();
            }
        } finally {
            setBusy(false);
        }
    };

    const captchaField = captchaRequired ? (
        <TurnstileField key={captchaRound} action="guest-email" onToken={setCaptchaToken} className="basis-full" />
    ) : null;

    const sendCode = () => {
        if (!isPlausibleEmail(email)) {
            setError({ message: 'Enter a valid email address.', signIn: false });
            return;
        }
        const problem = passwordProblem(password);
        if (problem) {
            setError({ message: passwordProblemMessage(problem), signIn: false });
            return;
        }
        if (captchaRequired && !captchaToken) {
            setError({ message: 'Finish the “I’m human” check, then try again.', signIn: false });
            return;
        }
        void run(async () => {
            await startGuestEmailUpgrade(email, captchaToken);
            setCode('');
            // A new challenge for the sign-in the next step ends in: the token
            // just spent on the code request cannot be redeemed twice.
            goTo('code');
        });
    };

    const confirm = () => {
        if (!/^\d{6}$/.test(code.replace(/[\s-]/g, ''))) {
            setError({ message: 'Enter the 6-digit code from the email.', signIn: false });
            return;
        }
        if (captchaRequired && !captchaToken) {
            setError({ message: 'Finish the “I’m human” check, then try again.', signIn: false });
            return;
        }
        void run(async () => {
            const outcome = await confirmGuestEmailUpgrade({ email, code, password, captchaToken });
            setPassword('');
            setState(outcome === 'signed_in' ? 'done' : 'signInNeeded');
        });
    };

    const errorLine = error ? (
        <span role="alert" className="text-danger">
            {error.message}{' '}
            {error.signIn ? (
                <Link to="/login" className="font-medium underline">
                    Sign in instead
                </Link>
            ) : null}
        </span>
    ) : null;

    const dismissButton = (
        <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setState('dismissed')}
            className="rounded p-1 text-amber-700 transition hover:text-amber-900"
        >
            <CloseIcon size={16} />
        </button>
    );

    return (
        <div data-ui-overlay className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
            {state === 'done' ? (
                <div className="flex items-center justify-between gap-2">
                    <p role="status">
                        Saved. Your work now belongs to <span className="font-medium">{email}</span> — sign in with it
                        and your password on any device.
                    </p>
                    {dismissButton}
                </div>
            ) : state === 'signInNeeded' ? (
                <div className="flex items-center justify-between gap-2">
                    <p role="status">
                        Your email <span className="font-medium">{email}</span> is saved, but we couldn&apos;t sign you
                        back in.{' '}
                        <Link to="/login" className="font-medium underline">
                            Sign in with it
                        </Link>{' '}
                        and your password to keep working.
                    </p>
                    {dismissButton}
                </div>
            ) : state === 'code' ? (
                <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        confirm();
                    }}
                >
                    <p className="basis-full">
                        We emailed a 6-digit code to <span className="font-medium">{email}</span>. Enter it to save your
                        work.
                    </p>
                    <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        aria-label="Code from the email"
                        value={code}
                        autoFocus
                        placeholder="123456"
                        maxLength={9}
                        onChange={(e) => setCode(e.target.value)}
                        className={`${INPUT_CLASS} max-w-32 tracking-widest`}
                    />
                    {captchaField}
                    <button type="submit" disabled={busy} className={PRIMARY_CLASS}>
                        {busy ? 'Saving…' : 'Save my work'}
                    </button>
                    <button type="button" disabled={busy} onClick={sendCode} className={LINK_BUTTON_CLASS}>
                        Send a new code
                    </button>
                    <button type="button" disabled={busy} onClick={() => goTo('details')} className={LINK_BUTTON_CLASS}>
                        Change email
                    </button>
                    {errorLine}
                </form>
            ) : state === 'details' ? (
                <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        sendCode();
                    }}
                >
                    <input
                        type="email"
                        autoComplete="email"
                        aria-label="Email"
                        value={email}
                        autoFocus
                        placeholder="you@example.com"
                        onChange={(e) => setEmail(e.target.value)}
                        className={INPUT_CLASS}
                    />
                    <input
                        type="password"
                        autoComplete="new-password"
                        aria-label="Choose a password"
                        value={password}
                        placeholder="Choose a password"
                        onChange={(e) => setPassword(e.target.value)}
                        className={INPUT_CLASS}
                    />
                    {captchaField}
                    <button type="submit" disabled={busy} className={PRIMARY_CLASS}>
                        {busy ? 'Sending…' : 'Email me a code'}
                    </button>
                    <button type="button" onClick={() => goTo('collapsed')} className={LINK_BUTTON_CLASS}>
                        Cancel
                    </button>
                    {errorLine}
                </form>
            ) : (
                <div className="flex items-center justify-between gap-2">
                    <p>
                        You&apos;re annotating as a guest — this work lives only in this browser.{' '}
                        <button type="button" onClick={() => goTo('details')} className="font-medium underline">
                            Add your email to keep it
                        </button>
                    </p>
                    {dismissButton}
                </div>
            )}
        </div>
    );
};
