import { describe, expect, it } from 'vitest';

import {
    supabaseEnvPrefixFor,
    supabasePreconnectPlan,
    supabasePreconnectScript,
} from '@/lib/supabasePreconnectOrigins';

const PROD = 'https://jibgwgosihadbjgxdsfe.supabase.co';
const DEV = 'https://qdbnlrgylelelvwbkvnm.supabase.co';

/** Runs the emitted script against a fake page at `hostname`; returns the preconnect links it added. */
const runAt = (source: string, hostname: string): Array<{ rel: string; href: string; crossOrigin: string }> => {
    const added: Array<{ rel: string; href: string; crossOrigin: string }> = [];
    const fakeDocument = {
        createElement: () => ({ rel: '', href: '', crossOrigin: '' }),
        head: { appendChild: (link: { rel: string; href: string; crossOrigin: string }) => added.push(link) },
    };
    // The script is our own build output, run against a fake page.
    new Function('location', 'document', source)({ hostname }, fakeDocument);
    return added;
};

describe('supabasePreconnectPlan', () => {
    it('lets the hostname decide when the build only knows both projects (the release build)', () => {
        expect(supabasePreconnectPlan({ VITE_SUPABASE_PROD_URL: PROD, VITE_SUPABASE_DEV_URL: DEV })).toEqual({
            kind: 'by-host',
            prodOrigin: PROD,
            devOrigin: DEV,
        });
    });

    it('names the one project an explicit VITE_SUPABASE_URL picks, as supabaseConfig does', () => {
        expect(
            supabasePreconnectPlan({
                VITE_SUPABASE_URL: `${DEV}/`,
                VITE_SUPABASE_ANON_KEY: 'key',
                VITE_SUPABASE_PROD_URL: PROD,
                VITE_SUPABASE_DEV_URL: DEV,
            }),
        ).toEqual({ kind: 'static', origin: DEV });
        // Without its key the explicit URL is ignored at runtime, so here too.
        expect(supabasePreconnectPlan({ VITE_SUPABASE_URL: DEV, VITE_SUPABASE_PROD_URL: PROD }).kind).toBe('by-host');
    });

    it('warms nothing for a local http stack or an unconfigured build', () => {
        expect(
            supabasePreconnectPlan({ VITE_SUPABASE_URL: 'http://127.0.0.1:54421', VITE_SUPABASE_ANON_KEY: 'k' }),
        ).toEqual({ kind: 'none' });
        expect(supabasePreconnectPlan({})).toEqual({ kind: 'none' });
        expect(supabasePreconnectPlan({ VITE_SUPABASE_DEV_URL: 'not a url' })).toEqual({ kind: 'none' });
    });
});

describe('supabasePreconnectScript', () => {
    const script = supabasePreconnectScript({ prodOrigin: PROD, devOrigin: DEV });

    it.each(['cleffy.io', 'www.cleffy.io', 'CLEFFY.IO'])('preconnects %s to production only', (hostname) => {
        expect(runAt(script, hostname)).toEqual([{ rel: 'preconnect', href: PROD, crossOrigin: '' }]);
    });

    it.each(['dev.cleffy.io', 'cleffy.vercel.app', 'localhost', 'cleffy.io.evil.example'])(
        'preconnects %s to the dev project, never production',
        (hostname) => {
            expect(runAt(script, hostname)).toEqual([{ rel: 'preconnect', href: DEV, crossOrigin: '' }]);
        },
    );

    it('adds nothing when the host’s project is not configured', () => {
        expect(runAt(supabasePreconnectScript({ prodOrigin: PROD, devOrigin: null }), 'dev.cleffy.io')).toEqual([]);
    });

    it('picks exactly as the client does', () => {
        for (const hostname of ['cleffy.io', 'www.cleffy.io', 'dev.cleffy.io', 'localhost']) {
            const expected = supabaseEnvPrefixFor(hostname) === 'VITE_SUPABASE_PROD' ? PROD : DEV;
            expect(runAt(script, hostname).map((l) => l.href)).toEqual([expected]);
        }
    });
});
