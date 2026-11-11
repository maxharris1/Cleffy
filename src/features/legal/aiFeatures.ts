import { features } from '@/lib/features';

/**
 * Which AI features this build ships, as the legal documents need to know it.
 *
 * Smart import (analyze-annotations → Anthropic) is OFF at launch and gated by
 * VITE_FEATURE_SMART_IMPORT, like the flags in src/lib/features.ts. It is read
 * here directly rather than from `features` because that flag is being added to
 * features.ts on another branch (mh/launch-consent); once both are merged this
 * can read `features.smartImport` instead. Same rule either way: only "1" turns
 * it on.
 */
export const aiFeatures = {
    smartImport: import.meta.env.VITE_FEATURE_SMART_IMPORT === '1',
    fingering: features.fingering,
    playalong: features.playalong,
} as const;

/** Whether any feature sends score content to Anthropic in this build. */
export const sendsToAnthropic = aiFeatures.smartImport || aiFeatures.fingering;
