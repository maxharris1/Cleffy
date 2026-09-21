/**
 * Prompt and post-processing for the transcribe-ink function, kept free of
 * Deno globals so they unit-test under vitest.
 */

/** The model answers with exactly this when the ink is not legible text. */
export const UNREADABLE = '?';

/** A teaching note is short; anything longer is a misread. */
export const MAX_TEXT_CHARS = 80;

export const TRANSCRIBE_PROMPT =
    'This image shows one short line of handwriting from a music teacher, ' +
    'drawn in ink on a blank background. Transcribe the handwriting. ' +
    'Return the text only — no quotes, no explanation, no extra words. ' +
    'Keep the writer’s abbreviations and punctuation (e.g. "rit.", "ped."). ' +
    `If it is not legible text (a drawing, a line, a symbol), return exactly ${UNREADABLE}`;

/** One line, trimmed, stripped of wrapping quotes; null when the model abstained or rambled. */
export const cleanTranscription = (raw: string): string | null => {
    let text = raw.trim().split('\n')[0]?.trim() ?? '';
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
        text = text.slice(1, -1).trim();
    }
    if (text === '' || text === UNREADABLE || text.length > MAX_TEXT_CHARS) {
        return null;
    }
    return text;
};
