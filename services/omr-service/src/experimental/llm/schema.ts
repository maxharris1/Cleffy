/**
 * Compact LLM transcription format. Kept deliberately small: a vision model
 * pays per output token, and MusicXML is ~50× more verbose than this. The
 * service turns it into MusicXML (toMusicXml.ts) so the production parser,
 * meter correction, repeat unrolling and ScoreData caps are all reused.
 *
 * Voice grammar (one string per voice, events separated by spaces):
 *   event    := ['g'] pitches ':' duration ['~']
 *   pitches  := 'r' | pitch | '[' pitch (' ' pitch)* ']'
 *   pitch    := [A-G] ('#'|'##'|'x'|'b'|'bb')? octave      sounding pitch, C4 = middle C
 *   duration := ('w'|'h'|'q'|'e'|'s'|'t'|'x') '.'* ('/3'|'/5'|'/6'|'/7')?
 *               w=whole h=half q=quarter e=eighth s=16th t=32nd x=64th;
 *               '.'=dotted; '/3' triplet (2/3 of nominal), '/5' quintuplet (4/5),
 *               '/6' sextuplet (2/3), '/7' septuplet (4/7)
 *   'g' prefix = grace note (takes no time); '~' = this event ties into the next.
 */

export interface LlmMeasure {
    /** Measure number as counted by the model within the request (1-based). */
    n: number;
    /** "4/4" only when a time signature is printed in this bar. */
    ts?: string | null;
    /** Key signature in fifths (-7..7) only when printed in this bar. */
    key?: number | null;
    /** Metronome mark bpm only when printed. */
    tempo?: number | null;
    /** Repeat barlines touching this bar ('none' when there are none). */
    rep?: 'none' | 'start' | 'end' | 'both' | null;
    /** Volta bracket number this bar lies under. */
    ending?: number | null;
    /** Dynamic marking printed in this bar (p, mf, ff, …). */
    dyn?: string | null;
    /** Upper-staff voices. */
    rh: string[];
    /** Lower-staff voices. */
    lh: string[];
}

export interface LlmSystem {
    measures: LlmMeasure[];
}

export interface LlmPageTranscription {
    systems: LlmSystem[];
}

/** Anthropic tool input schema (strict). */
export const TRANSCRIBE_TOOL = {
    name: 'report_transcription',
    description:
        'Report the complete transcription of the score image: every system (grand-staff row) in top-to-bottom order, every measure in each system left to right, every voice on each staff.',
    strict: true,
    input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['systems'],
        properties: {
            systems: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['measures'],
                    properties: {
                        measures: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['n', 'ts', 'key', 'tempo', 'rep', 'ending', 'dyn', 'rh', 'lh'],
                                properties: {
                                    n: { type: 'integer' },
                                    ts: { type: ['string', 'null'] },
                                    key: { type: ['integer', 'null'] },
                                    tempo: { type: ['number', 'null'] },
                                    rep: { type: 'string', enum: ['none', 'start', 'end', 'both'] },
                                    ending: { type: ['integer', 'null'] },
                                    dyn: { type: ['string', 'null'] },
                                    rh: { type: 'array', items: { type: 'string' } },
                                    lh: { type: 'array', items: { type: 'string' } },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
} as const;

/** Plain JSON schema for providers without tool-use strictness (Gemini responseSchema). */
export const TRANSCRIBE_JSON_SCHEMA = TRANSCRIBE_TOOL.input_schema;
