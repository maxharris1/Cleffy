import { describe, expect, it } from 'vitest';

import { collectSupabasePreconnectOrigins } from '@/lib/supabasePreconnectOrigins';

describe('collectSupabasePreconnectOrigins', () => {
    it('emits both production and dev hosts when VITE_SUPABASE_URL is absent', () => {
        expect(
            collectSupabasePreconnectOrigins({
                VITE_SUPABASE_PROD_URL: 'https://prod.supabase.co',
                VITE_SUPABASE_DEV_URL: 'https://dev.supabase.co',
            }),
        ).toEqual(['https://prod.supabase.co', 'https://dev.supabase.co']);
    });

    it('dedupes overlapping URLs and skips non-https', () => {
        expect(
            collectSupabasePreconnectOrigins({
                VITE_SUPABASE_URL: 'https://prod.supabase.co',
                VITE_SUPABASE_PROD_URL: 'https://prod.supabase.co',
                VITE_SUPABASE_DEV_URL: 'http://localhost:54321',
            }),
        ).toEqual(['https://prod.supabase.co']);
    });
});
