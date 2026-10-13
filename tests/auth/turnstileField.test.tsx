import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterPage } from '../../src/features/auth/RegisterPage';
import { TurnstileField } from '../../src/features/auth/TurnstileField';
import {
    isTurnstileEnabled,
    resetTurnstileLoaderForTests,
    turnstileSiteKey,
    type TurnstileRenderOptions,
} from '../../src/features/auth/turnstile';

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

const SITE_KEY = '1x00000000000000000000AA';

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
    vi.unstubAllEnvs();
    resetTurnstileLoaderForTests();
    delete (window as { turnstile?: unknown }).turnstile;
    document.getElementById('cf-turnstile-script')?.remove();
});

const renderRegister = () =>
    render(
        <MemoryRouter initialEntries={['/register']}>
            <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/library" element={<p>library</p>} />
            </Routes>
        </MemoryRouter>,
    );

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
        renderRegister();
        expect(screen.queryByTestId('turnstile-field')).not.toBeInTheDocument();
        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        await user.click(screen.getByRole('button', { name: 'Create account' }));

        // No "finish the check" refusal: the form went through to signUp,
        // which is what "inert" has to mean for every existing test to stay
        // valid.
        expect(screen.queryByText(/I’m human/)).not.toBeInTheDocument();
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

    it('refuses to submit the sign-up form until the check is finished', async () => {
        vi.stubEnv('VITE_TURNSTILE_SITE_KEY', SITE_KEY);
        const { rendered } = stubTurnstile();
        const user = userEvent.setup();
        renderRegister();
        await waitFor(() => expect(rendered).toHaveLength(1));

        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        await user.click(screen.getByRole('button', { name: 'Create account' }));

        // Said last of the form's complaints: a form with a typo in it is not
        // first told off about the robot check.
        expect(await screen.findByText(/Finish the “I’m human” check/)).toBeInTheDocument();
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
