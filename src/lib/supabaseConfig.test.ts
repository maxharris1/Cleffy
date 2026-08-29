import { afterEach, describe, expect, it, vi } from 'vitest';

import { supabaseConfig } from '@/lib/supabase';

/**
 * Only cleffy.io may talk to the production project.
 *
 * dev.cleffy.io shipped pointing at production for its entire existence: the
 * Vercel Preview override that was supposed to repoint it was documented as done
 * and never applied, and because it lived in a dashboard rather than the repo,
 * nothing failed and nobody could see it. These assertions are the version of
 * that rule which cannot be true only on paper.
 */

const PROD = 'https://jibgwgosihadbjgxdsfe.supabase.co';
const DEV = 'https://qdbnlrgylelelvwbkvnm.supabase.co';

const at = (hostname: string) => {
    vi.stubGlobal('location', { hostname } as Location);
};

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const withProjects = () => {
    vi.stubEnv('VITE_SUPABASE_PROD_URL', PROD);
    vi.stubEnv('VITE_SUPABASE_PROD_ANON_KEY', 'prod-key');
    vi.stubEnv('VITE_SUPABASE_DEV_URL', DEV);
    vi.stubEnv('VITE_SUPABASE_DEV_ANON_KEY', 'dev-key');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
};

describe('which Supabase project a host talks to', () => {
    it.each(['cleffy.io', 'www.cleffy.io', 'CLEFFY.IO'])('%s is production', (hostname) => {
        withProjects();
        at(hostname);
        expect(supabaseConfig()).toEqual({ url: PROD, anonKey: 'prod-key' });
    });

    it.each([
        'dev.cleffy.io',
        'cleffy.vercel.app',
        'cleffy-git-dev-maxs-projectsd.vercel.app',
        'localhost',
        '192.168.1.42',
    ])('%s is the dev branch, never production', (hostname) => {
        withProjects();
        at(hostname);
        expect(supabaseConfig()).toEqual({ url: DEV, anonKey: 'dev-key' });
    });

    // A lookalike host must not inherit production by resembling it.
    it('gives a lookalike host the dev project', () => {
        withProjects();
        at('cleffy.io.evil.example');
        expect(supabaseConfig().url).toBe(DEV);
    });

    it('lets an explicit pair win, which is what a local .env and the local stack set', () => {
        withProjects();
        vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-key');
        at('localhost');
        expect(supabaseConfig()).toEqual({ url: 'http://127.0.0.1:54321', anonKey: 'local-key' });
    });

    // Half a pair is not a configuration: falling back beats sending a request
    // with `apikey: undefined` and reading the 401 as something else.
    it('ignores a half-set explicit pair', () => {
        withProjects();
        vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
        at('cleffy.io');
        expect(supabaseConfig().url).toBe(PROD);
    });

    it('reports nothing configured when no project is set at all', () => {
        vi.stubEnv('VITE_SUPABASE_URL', '');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
        vi.stubEnv('VITE_SUPABASE_PROD_URL', '');
        vi.stubEnv('VITE_SUPABASE_PROD_ANON_KEY', '');
        vi.stubEnv('VITE_SUPABASE_DEV_URL', '');
        vi.stubEnv('VITE_SUPABASE_DEV_ANON_KEY', '');
        at('cleffy.io');
        expect(supabaseConfig()).toEqual({ url: undefined, anonKey: undefined });
    });
});
