/**
 * Build-time switches for features that are built but not part of the current
 * release. Each defaults OFF: a deploy turns one on by setting its VITE_FEATURE_*
 * variable to "1". Gate every entry point on these (buttons, background
 * requests, lazy chunks) so a switched-off feature costs nothing at runtime.
 */
const flag = (value: string | undefined): boolean => value === '1';

export const features = {
    /** Play-along: score analysis (OMR), the transport bar and audio playback. */
    playalong: flag(import.meta.env.VITE_FEATURE_PLAYALONG),
    /** Fingering suggestions: the toolbar's Fingering tool and the viewer overlay. */
    fingering: flag(import.meta.env.VITE_FEATURE_FINGERING),
    /** Print handwriting: on-device conversion of handwritten digits and symbols to type. */
    printHandwriting: flag(import.meta.env.VITE_FEATURE_PRINT_HANDWRITING),
} as const;
