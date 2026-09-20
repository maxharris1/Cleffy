import { ensureMusicFontLoaded } from '@/features/viewer/ink/musicFont';
import { isSupabaseConfigured, requireSupabaseConfig } from '@/lib/supabase';

/**
 * Kick Bravura and the transcribe-ink isolate when Print turns on so the
 * first convert does not pay a cold font fetch or a cold edge start.
 */
export const warmPrintPipeline = (): void => {
    void ensureMusicFontLoaded();
    if (!isSupabaseConfigured()) {
        return;
    }
    try {
        const { url, anonKey } = requireSupabaseConfig();
        void fetch(`${url}/functions/v1/transcribe-ink`, {
            method: 'OPTIONS',
            headers: { apikey: anonKey },
        }).catch(() => undefined);
    } catch {
        // Local / unconfigured — digits still convert on-device.
    }
};
