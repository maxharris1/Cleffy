import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterPage } from '../../src/features/auth/RegisterPage';
import { UpgradeBanner } from '../../src/features/auth/UpgradeBanner';
import { TurnstileField } from '../../src/features/auth/TurnstileField';
import {
    isTurnstileEnabled,
    resetTurnstileLoaderForTests,
    turnstileSiteKey,
    type TurnstileRenderOptions,
} from '../../src/features/auth/turnstile';
import { TURNSTILE_NEEDS_USER, TURNSTILE_SLOW, useTurnstileToken } from '../../src/features/auth/useTurnstileToken';
import { passAgeScreen } from '../../src/test/ageScreen';

/**
 * The widget half of the Turnstile work, and above all the claim the whole
 * branch rests on: with `VITE_TURNSTILE_SITE_KEY` unset, NOTHING changes.
 *
 * What these tests cannot prove, since there is no browser here that Cloudflare
 * would serve: that a real challenge renders, or that a token a real widget
 * produces is one siteverify accepts. `window.turnstile` is a stub throughout.
 * What they do prove is the wiring either side of it — when a script is
 * fetched, when a form refuses to submit, and that a build without the key
 * neither fetches nor refuses anything.
 */

/** Cloudflare's always-passes test key: the invisible path. */
const SITE_KEY = '1x00000000000000000000AA';
/** Cloudflare's always-challenges test key: the widget has to show itself. */
const CHALLENGE_KEY = '3x00000000000000000000FF';

const signUpWithPassword = vi.hoisted(() => vi.fn());
const startGuestEmailUpgrade = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    signUpWithPassword: (...args: unknown[]) => signUpWithPassword(...args),
}));

vi.mock('@/features/auth/guestUpgrade', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    startGuestEmailUpgrade: (...args: unknown[]) => startGuestEmailUpgrade(...args),
}));

/** A fake `window.turnstile`, recording what it was asked to render. */
const stubTurnstile = () => {
    const rendered: TurnstileRenderOptions[] = [];
    const removed: string[] = [];
    Object.assign(window, {
        turnstile: {
            render: (_host: HTMLElement, options: TurnstileRenderOptions) => {
                rendered.push(options);
                return `widget-${rendered.length}`;
            },
            remove: (id: string) => removed.push(id),
            reset: () => undefined,
        },
    });
    return { rendered, removed };
};

afterEach(() => {
    cleanup();
    signUpWithPassword.mockReset();
    startGuestEmailUpgrade.mockReset();
    vi.unstubAllEnvs();
    resetTurnstileLoaderForTests();
    delete (window as { turnstile?: unknown }).turnstile;
    document.getElementById('cf-turnstile-script')?.remove();
});

const renderRegister = async () => {
    render(
        <MemoryRouter initialEntries={['/register']}>
            <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/library" element={<p>library</p>} />
            </Routes>
        </MemoryRouter>,
    );
    // Past the age screen: these tests are about the form behind it.
    await passAgeScreen();
};

describe('with no site key — every build today', () => {
    it('reports Turnstile off', () => {
        expect(turnstileSiteKey()).toBeNull();
        expect(isTurnstileEnabled()).toBe(false);
    });

    it('renders nothing and fetches no script', () => {
        render(<TurnstileField action="signup" onToken={vi.fn()} />);
        expect(screen.queryByTestId('turnstile-field')).not.toBeInTheDocument();
        // The lazy-load promise is never even created: Cloudflare's script tag
        // does not go into the document, so the page makes no request to them.
        expect(document.getElementById('cf-turnstile-script')).toBeNull();
    });

    it('leaves the sign-up form submittable with no token at all', async () => {
        const user = userEvent.setup();
        await renderRegister();
        expect(screen.queryByTestId('turnstile-field')).not.toBeInTheDocument();
        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        await user.click(screen.getByRole('button', { name: 'Create account' }));

        // No "finish the check" refusal: the form went through to signUp,
        // which is what "inert" has to mean for every existing test to stay
        // valid.
        await waitFor(() => expect(signUpWithPassword).toHaveBeenCalledOnce());
        expect(signUpWithPassword.mock.calls[0]![2]).toBeNull();
        expect(screen.queryByText(/I’m human/)).not.toBeInTheDocument();
    });

    it('hands submits no token, straight away', async () => {
        const { result } = renderHook(() => useTurnstileToken());
        expect(result.current.required).toBe(false);
        await expect(result.current.waitForToken()).resolves.toEqual({ ok: true, token: null });
    });

    it('treats a blank or whitespace key as unset, not as a key', () => {
        for (const value of ['', '   ']) {
            vi.stubEnv('VITE_TURNSTILE_SITE_KEY', value);
            expect(isTurnstileEnabled(), JSON.stringify(value)).toBe(false);
            vi.unstubAllEnvs();
        }
    });
});

describe('with a site key set', () => {
    it('renders the widget for the named action and hands the token up', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        const onToken = vi.fn();
        render(<TurnstileField action="signup" onToken={onToken} />);

        await waitFor(() => expect(rendered).toHaveLength(1));
        expect(rendered[0]).toMatchObject({ sitekey: SITE_KEY, action: 'signup' });

        rendered[0]!.callback('cf-token');
        expect(onToken).toHaveBeenCalledWith('cf-token');
    });

    it('withdraws the token when the challenge expires or errors', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        const onToken = vi.fn();
        render(<TurnstileField action="login" onToken={onToken} />);
        await waitFor(() => expect(rendered).toHaveLength(1));

        // A token Cloudflare has disowned is one the server will refuse —
        // keeping the last good one would turn a re-solvable check into a
        // puzzling failure on a form that looks complete.
        rendered[0]!.callback('cf-token');
        rendered[0]!['expired-callback']!();
        expect(onToken).toHaveBeenLastCalledWith(null);

        rendered[0]!['error-callback']!();
        expect(onToken).toHaveBeenLastCalledWith(null);
    });

    it('says so, rather than leaving a dead submit button, when the script cannot load', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        // No window.turnstile, and jsdom never fires load on the injected
        // script — so drive the error path the way a blocked request would.
        render(<TurnstileField action="signup" onToken={vi.fn()} />);
        const script = await waitFor(() => {
            const el = document.getElementById('cf-turnstile-script');
            expect(el).not.toBeNull();
            return el!;
        });
        script.dispatchEvent(new Event('error'));

        expect(await screen.findByText(/couldn’t load/i)).toBeInTheDocument();
    });

    it('fetches Cloudflare’s script once, however many widgets mount', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        // No api present, so the loader has to inject — and the two fields
        // share one in-flight load rather than racing two script tags in.
        // (The upgrade banner mounts a field on each of its two steps, and the
        // login page can have one in the form and another in the resend.)
        render(
            <>
                <TurnstileField action="a" onToken={vi.fn()} />
                <TurnstileField action="b" onToken={vi.fn()} />
            </>,
        );
        await waitFor(() => expect(document.querySelectorAll('#cf-turnstile-script')).toHaveLength(1));
    });

    it('does not re-fetch the script when the api is already on the page', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        render(<TurnstileField action="signup" onToken={vi.fn()} />);
        await waitFor(() => expect(rendered).toHaveLength(1));
        expect(document.getElementById('cf-turnstile-script')).toBeNull();
    });

    it('renders interaction-only, leaving refresh-expired at Cloudflare’s default', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        render(<TurnstileField action="signup" onToken={vi.fn()} />);
        await waitFor(() => expect(rendered).toHaveLength(1));
        expect(rendered[0]).toMatchObject({ appearance: 'interaction-only' });
        expect(rendered[0]).not.toHaveProperty('refresh-expired');
    });

    it('takes no space while hidden, and its place in the form once a challenge shows', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', CHALLENGE_KEY);
        const { rendered } = stubTurnstile();
        const onNeedsUser = vi.fn();
        render(<TurnstileField action="signup" onToken={vi.fn()} onNeedsUser={onNeedsUser} className="basis-full" />);
        await waitFor(() => expect(rendered).toHaveLength(1));

        const wrapper = screen.getByTestId('turnstile-field').parentElement!;
        expect(wrapper.className).toBe('absolute');

        act(() => rendered[0]!['before-interactive-callback']!());
        expect(wrapper.className).toBe('mt-4 basis-full');
        expect(onNeedsUser).toHaveBeenCalledOnce();
    });

    it('signs up a passing visitor with no visible check, waiting for a token that is still on its way', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: true });
        const { rendered } = stubTurnstile();
        const user = userEvent.setup();
        await renderRegister();
        await waitFor(() => expect(rendered).toHaveLength(1));
        expect(screen.getByTestId('turnstile-field').parentElement!.className).toBe('absolute');

        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        // Submitted before Cloudflare answered: the form waits, it does not
        // tell the visitor to finish a check they cannot see.
        await user.click(screen.getByRole('button', { name: 'Create account' }));
        expect(screen.queryByText(/I’m human/)).not.toBeInTheDocument();
        expect(signUpWithPassword).not.toHaveBeenCalled();

        act(() => rendered[0]!.callback('cf-token'));

        await waitFor(() => expect(signUpWithPassword).toHaveBeenCalledOnce());
        expect(signUpWithPassword.mock.calls[0]!.slice(0, 3)).toEqual([
            'teacher@example.com',
            'letters4ever',
            'cf-token',
        ]);
        expect(screen.queryByText(/I’m human/)).not.toBeInTheDocument();
    });

    it('with the always-challenge key, points at the inline challenge, then completes once it is solved', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', CHALLENGE_KEY);
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: true });
        const { rendered } = stubTurnstile();
        const user = userEvent.setup();
        await renderRegister();
        await waitFor(() => expect(rendered).toHaveLength(1));
        act(() => rendered[0]!['before-interactive-callback']!());

        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        await user.click(screen.getByRole('button', { name: 'Create account' }));

        expect(await screen.findByText(TURNSTILE_NEEDS_USER)).toBeInTheDocument();
        expect(signUpWithPassword).not.toHaveBeenCalled();

        act(() => rendered[0]!.callback('cf-solved'));
        await user.click(screen.getByRole('button', { name: 'Create account' }));

        await waitFor(() => expect(signUpWithPassword).toHaveBeenCalledOnce());
        expect(signUpWithPassword.mock.calls[0]![2]).toBe('cf-solved');
    });

    it('says the check couldn’t load when the script is blocked, instead of waiting', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { result } = renderHook(() => useTurnstileToken());
        render(
            <TurnstileField
                action="signup"
                onToken={result.current.onToken}
                onNeedsUser={result.current.onNeedsUser}
            />,
        );
        const script = await waitFor(() => {
            const el = document.getElementById('cf-turnstile-script');
            expect(el).not.toBeNull();
            return el!;
        });
        script.dispatchEvent(new Event('error'));
        await screen.findByText(/couldn’t load/i);

        await expect(result.current.waitForToken()).resolves.toEqual({ ok: false, message: TURNSTILE_NEEDS_USER });
    });

    it('stops waiting at once when the challenge errors', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        const { result } = renderHook(() => useTurnstileToken());
        render(
            <TurnstileField action="login" onToken={result.current.onToken} onNeedsUser={result.current.onNeedsUser} />,
        );
        await waitFor(() => expect(rendered).toHaveLength(1));

        const waiting = result.current.waitForToken();
        act(() => rendered[0]!['error-callback']!());
        await expect(waiting).resolves.toEqual({ ok: false, message: TURNSTILE_NEEDS_USER });
    });

    it('gives up on a token that never comes without blaming the visitor', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { result } = renderHook(() => useTurnstileToken());
        await expect(result.current.waitForToken(5)).resolves.toEqual({ ok: false, message: TURNSTILE_SLOW });
    });

    it('forgets a spent token on renew', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { result } = renderHook(() => useTurnstileToken());
        act(() => result.current.onToken('cf-token'));
        await expect(result.current.waitForToken()).resolves.toEqual({ ok: true, token: 'cf-token' });

        act(() => result.current.renew());
        expect(result.current.round).toBe(1);
        await expect(result.current.waitForToken(5)).resolves.toEqual({ ok: false, message: TURNSTILE_SLOW });
    });

    it('cancels a wait still pending on renew, so no later widget can resume it', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { result } = renderHook(() => useTurnstileToken());
        const settled = vi.fn();
        const waiting = result.current.waitForToken().then((wait) => {
            settled(wait);
            return wait;
        });

        act(() => result.current.renew());
        act(() => result.current.onToken('next-widget-token'));

        await expect(waiting).resolves.toEqual({ ok: false, message: null });
        expect(settled).toHaveBeenCalledOnce();
        await expect(result.current.waitForToken()).resolves.toEqual({ ok: true, token: 'next-widget-token' });
    });

    it('never sends a guest email request the guest cancelled, when a later widget returns a token', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        startGuestEmailUpgrade.mockResolvedValue(undefined);
        const { rendered } = stubTurnstile();
        const user = userEvent.setup();
        render(
            <MemoryRouter>
                <UpgradeBanner isGuest />
            </MemoryRouter>,
        );

        await user.click(screen.getByRole('button', { name: 'Add your email to keep it' }));
        await waitFor(() => expect(rendered).toHaveLength(1));
        await user.type(screen.getByRole('textbox', { name: 'Email' }), 'cancelled@example.com');
        await user.type(screen.getByLabelText('Choose a password'), 'Correct1horse');
        await user.click(screen.getByRole('button', { name: 'Email me a code' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await user.click(screen.getByRole('button', { name: 'Add your email to keep it' }));
        await waitFor(() => expect(rendered).toHaveLength(2));
        act(() => rendered[1]!.callback('new-widget-token'));

        await waitFor(() => expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled());
        expect(startGuestEmailUpgrade).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox', { name: 'Code from the email' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('tears the widget down when the field unmounts', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered, removed } = stubTurnstile();
        const view = render(<TurnstileField action="signup" onToken={vi.fn()} />);
        await waitFor(() => expect(rendered).toHaveLength(1));
        view.unmount();
        expect(removed).toEqual(['widget-1']);
    });
});
