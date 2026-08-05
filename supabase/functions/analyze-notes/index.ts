import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey } from '../_shared/rateLimit.ts';

/**
 * Fingering-diagram note recognition: given a crop of a selected score region
 * (committed annotations composited in, so handwritten/typed fingering digits
 * are visible) plus the full page for clef/key context, ask Claude which
 * pitches are in the region, grouped into simultaneous events, with any
 * fingering digit visibly attached to each note. The client shows an editable
 * review before rendering the keyboard diagram, and degrades to manual note
 * entry on any failure.
 *
 * Guards: JWT required (config.toml), any document MEMBER (owner/editor/viewer
 * — students are the audience for this feature, unlike analyze-annotations'
 * owner-only gate), per-user and per-IP rate limits (fail closed), strict body
 * budgets, and a region-size cap so a request can't smuggle arbitrary bytes.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Note reading is accuracy-sensitive vision work — default to the strongest
 * generally-recommended model; override via secret for cost tuning. */
const MODEL = Deno.env.get('ANALYZE_NOTES_MODEL') ?? 'claude-opus-5';
const MAX_TOKENS = 8000;
/** Recognitions per user per hour / per IP per hour (dearer than classify). */
const USER_LIMIT = 40;
const IP_LIMIT = 120;
const WINDOW_MS = 3_600_000;

/** Base64 length budgets (≈ 1.2 MB binary each) and body cap. */
const MAX_IMAGE_B64 = 1_700_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Region area caps: reject accidental slivers and half-page grabs. */
const MIN_REGION_AREA = 0.0002;
const MAX_REGION_AREA = 0.5;

const MIDI_MIN = 21;
const MIDI_MAX = 108;

interface ImageMsg {
    mediaType?: string;
    dataBase64?: string;
}

interface AnalyzeBody {
    documentId?: string;
    page?: number;
    region?: { x?: number; y?: number; w?: number; h?: number };
    regionImage?: ImageMsg;
    contextImage?: ImageMsg;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const badImage = (img: ImageMsg | undefined): boolean =>
    !img ||
    typeof img.mediaType !== 'string' ||
    !IMAGE_TYPES.has(img.mediaType) ||
    typeof img.dataBase64 !== 'string' ||
    img.dataBase64.length === 0 ||
    img.dataBase64.length > MAX_IMAGE_B64;

const INSTRUCTIONS = `You are reading printed piano sheet music. Two images follow: the FULL PAGE
(for clef, key signature, and locating the region) and then the REGION — a
crop the user selected, which is the only part you report notes for.

Report every note whose notehead is inside the REGION image:
- "midi": the sounding pitch as a MIDI number (middle C = C4 = 60). Apply the
  key signature, accidentals, and any 8va/8vb markings.
- "name": the spelled pitch, e.g. "C#4" or "Bb3".
- "staff": "upper" for the upper staff of the system, "lower" for the lower.
  If the region shows a single staff, use "upper" and set clefLower to "none".
- "x","y","w","h": the notehead's bounding box as FRACTIONS of the REGION
  image (0..1, top-left origin).
- Group notes into "events" by vertical alignment: noteheads that sound
  together (a chord, or hands striking together) share one event. Number
  events left to right starting at 0.
- "finger": ONLY when a fingering digit 1-5 is visibly associated with this
  exact note (directly above/below its notehead, or clearly pointing to it).
  The region may carry colored handwritten or typed digits — those are
  annotations added by a teacher, not part of the printed score; read them as
  fingerings. Never invent fingerings for unmarked notes.
- "fingerConfidence": how sure you are the digit belongs to THIS note.
- "confidence": how sure you are of the PITCH ("low" when ledger lines,
  print quality, or crowding make it a guess).

Also report the key signature as a signed count of sharps (F major = -1,
D major = 2, C major = 0) and the clef of each staff as printed at the start
of the system containing the region.

Respond via the report_notes tool only.`;

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const contentLength = Number(req.headers.get('content-length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Request too large' }, 413);
    }

    const ipRate = await checkRateLimit(`notes-ip:${clientKey(req)}`, IP_LIMIT, WINDOW_MS);
    if (!ipRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: ipRate.retryAfterSec }, 429);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body: AnalyzeBody;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    if (!documentId || !uuidRe.test(documentId)) {
        return jsonResponse({ error: 'documentId must be a UUID' }, 400);
    }
    const page = body.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
        return jsonResponse({ error: 'page must be a non-negative integer' }, 400);
    }
    const region = body.region;
    const regionValues = [region?.x, region?.y, region?.w, region?.h];
    if (regionValues.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
        return jsonResponse({ error: 'region must be a normalized rect' }, 400);
    }
    const area = (region!.w as number) * (region!.h as number);
    if (area < MIN_REGION_AREA) {
        return jsonResponse({ error: 'Selection too small' }, 400);
    }
    if (area > MAX_REGION_AREA) {
        return jsonResponse({ error: 'Select a shorter passage', code: 'region_too_large' }, 400);
    }
    if (badImage(body.regionImage) || badImage(body.contextImage)) {
        return jsonResponse({ error: 'regionImage/contextImage missing or over budget' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // User-scoped client — RLS and document_role() decide access, never service role.
    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userError || !userId) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const userRate = await checkRateLimit(`notes:${userId}`, USER_LIMIT, WINDOW_MS);
    if (!userRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: userRate.retryAfterSec }, 429);
    }

    // ANY member may read notes — view-only students are this feature's audience.
    const { data: role, error: roleError } = await userClient.rpc('document_role', { doc: documentId });
    if (roleError || !['owner', 'editor', 'viewer'].includes(role as string)) {
        return jsonResponse({ error: 'Not a member of this score' }, 403);
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
        // Not configured — tell the client to degrade to manual entry, quietly.
        return jsonResponse({ error: 'Recognition is not configured', code: 'ai_unavailable' }, 503);
    }

    const anthropic = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });

    const content: Anthropic.ContentBlockParam[] = [
        { type: 'text', text: INSTRUCTIONS },
        { type: 'text', text: 'Full page for context:' },
        {
            type: 'image',
            source: {
                type: 'base64',
                media_type: body.contextImage!.mediaType as 'image/jpeg',
                data: body.contextImage!.dataBase64!,
            },
        },
        {
            type: 'text',
            text:
                `The REGION (selected at x=${(region!.x as number).toFixed(3)} ` +
                `y=${(region!.y as number).toFixed(3)} w=${(region!.w as number).toFixed(3)} ` +
                `h=${(region!.h as number).toFixed(3)} of the page). Report notes for this image only:`,
        },
        {
            type: 'image',
            source: {
                type: 'base64',
                media_type: body.regionImage!.mediaType as 'image/jpeg',
                data: body.regionImage!.dataBase64!,
            },
        },
    ];

    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            output_config: { effort: 'medium' },
            tools: [
                {
                    name: 'report_notes',
                    description:
                        'Report every note in the REGION image, grouped into simultaneous events, with any fingering digit visibly attached to a note.',
                    strict: true,
                    input_schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['clefUpper', 'clefLower', 'keySignature', 'events'],
                        properties: {
                            clefUpper: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'none'] },
                            clefLower: { type: 'string', enum: ['treble', 'bass', 'none'] },
                            keySignature: { type: 'integer' },
                            events: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['index', 'notes'],
                                    properties: {
                                        index: { type: 'integer' },
                                        notes: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                additionalProperties: false,
                                                required: ['name', 'midi', 'staff', 'x', 'y', 'w', 'h', 'confidence'],
                                                properties: {
                                                    name: { type: 'string' },
                                                    midi: { type: 'integer' },
                                                    staff: { type: 'string', enum: ['upper', 'lower'] },
                                                    x: { type: 'number' },
                                                    y: { type: 'number' },
                                                    w: { type: 'number' },
                                                    h: { type: 'number' },
                                                    finger: { type: 'integer' },
                                                    fingerConfidence: {
                                                        type: 'string',
                                                        enum: ['high', 'medium', 'low'],
                                                    },
                                                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            ],
            tool_choice: { type: 'tool', name: 'report_notes', disable_parallel_tool_use: true },
            messages: [{ role: 'user', content }],
        });

        if (response.stop_reason === 'refusal') {
            return jsonResponse({ error: 'Recognition declined', code: 'ai_unavailable' }, 502);
        }
        const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
        if (!toolUse) {
            return jsonResponse({ error: 'No reading produced', code: 'ai_unavailable' }, 502);
        }
        const input = toolUse.input as {
            clefUpper?: string;
            clefLower?: string;
            keySignature?: number;
            events?: {
                index: number;
                notes?: {
                    name?: string;
                    midi?: number;
                    staff?: string;
                    x?: number;
                    y?: number;
                    w?: number;
                    h?: number;
                    finger?: number;
                    fingerConfidence?: string;
                    confidence?: string;
                }[];
            }[];
        };

        // Strict schemas can't express numeric ranges — clamp/drop server-side
        // so the client only ever sees playable values.
        const clamp01 = (v: unknown): number =>
            typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
        const confidences = new Set(['high', 'medium', 'low']);
        const events = (Array.isArray(input.events) ? input.events : [])
            .filter((event) => typeof event?.index === 'number' && Number.isInteger(event.index))
            .map((event) => ({
                index: event.index,
                notes: (Array.isArray(event.notes) ? event.notes : [])
                    .filter(
                        (note) =>
                            typeof note?.midi === 'number' &&
                            Number.isInteger(note.midi) &&
                            note.midi >= MIDI_MIN &&
                            note.midi <= MIDI_MAX &&
                            (note.staff === 'upper' || note.staff === 'lower'),
                    )
                    .map((note) => ({
                        name: typeof note.name === 'string' ? note.name.slice(0, 8) : '',
                        midi: note.midi as number,
                        staff: note.staff as string,
                        x: clamp01(note.x),
                        y: clamp01(note.y),
                        w: clamp01(note.w),
                        h: clamp01(note.h),
                        finger:
                            typeof note.finger === 'number' && note.finger >= 1 && note.finger <= 5
                                ? Math.round(note.finger)
                                : null,
                        fingerConfidence: confidences.has(note.fingerConfidence ?? '')
                            ? note.fingerConfidence
                            : 'low',
                        confidence: confidences.has(note.confidence ?? '') ? note.confidence : 'low',
                    })),
            }))
            .filter((event) => event.notes.length > 0);

        const keySignature =
            typeof input.keySignature === 'number' && Number.isFinite(input.keySignature)
                ? Math.min(7, Math.max(-7, Math.round(input.keySignature)))
                : 0;
        const clefs = new Set(['treble', 'bass', 'alto', 'tenor', 'none']);
        const clefUpper = clefs.has(input.clefUpper ?? '') ? input.clefUpper : 'treble';
        const clefLower = input.clefLower === 'treble' || input.clefLower === 'none' ? input.clefLower : 'bass';

        return jsonResponse({ ok: true, page, keySignature, clefUpper, clefLower, events });
    } catch (err) {
        console.error('analyze-notes model call failed', err);
        return jsonResponse({ error: 'Recognition unavailable', code: 'ai_unavailable' }, 502);
    }
});
