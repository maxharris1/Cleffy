import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey } from '../_shared/rateLimit.ts';

/**
 * Smart-import classification: given one score page plus the deterministic
 * ink clusters the client detected, ask Claude what each cluster IS
 * (fingering digit, text, articulation like "tr", or a non-text mark) and
 * whether digit runs read as one text ("34323"). JSON-only responses; the
 * client degrades to strokes-only import on any failure.
 *
 * Guards: JWT required (config.toml), document owner only (also excludes
 * anonymous users — they can never own documents), per-user and per-IP rate
 * limits (fail closed), strict body budgets so a request can't smuggle
 * arbitrary bytes to the model.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 8000;
/** Page analyses per user per hour / per IP per hour. */
const USER_LIMIT = 60;
const IP_LIMIT = 120;
const WINDOW_MS = 3_600_000;

const MAX_CLUSTERS_PER_CALL = 60;
/** Base64 length budgets (≈ 1.2 MB / 90 KB binary). */
const MAX_PAGE_IMAGE_B64 = 1_700_000;
const MAX_CROP_B64 = 120_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface ClusterMsg {
    id: string;
    bbox: [number, number, number, number];
    colorHex: string;
    runId?: string;
    crop: { mediaType: string; dataBase64: string };
}

interface AnalyzeBody {
    documentId?: string;
    page?: number;
    pageImage?: { mediaType?: string; dataBase64?: string };
    clusters?: ClusterMsg[];
    runs?: { id: string; clusterIds: string[] }[];
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const badImage = (img: { mediaType?: string; dataBase64?: string } | undefined, maxB64: number): boolean =>
    !img ||
    typeof img.mediaType !== 'string' ||
    !IMAGE_TYPES.has(img.mediaType) ||
    typeof img.dataBase64 !== 'string' ||
    img.dataBase64.length === 0 ||
    img.dataBase64.length > maxB64;

const INSTRUCTIONS = `You are analyzing one page of printed sheet music that carries handwritten
annotations in colored ink (typically a teacher's fingering marks). The full
page image is provided for context, followed by one cropped image per
numbered ink cluster.

Classify every cluster:
- "digit": a single handwritten digit 1-5 (piano fingering). Set "text" to the digit.
- "text": handwritten letters/words/multi-digit sequences (e.g. "cresc.", "34323" written as one cramped run inside a single crop). Set "text" to the exact characters.
- "articulation": a musical shorthand like "tr", "ped", accents written as letters. Set "text" to it.
- "mark": non-text ink — brackets, circles, lines, arrows, slur corrections, highlighter swipes.
- "noise": not an annotation at all (scanner artifact, bleed-through, colored print).

For each run (a horizontal chain of same-color clusters listed with its member
cluster ids): decide "treatAsOneText". True only when the members read as ONE
written token (like "34323" over a trill, or letters of one word split into
clusters); then set "text" to the combined characters. False when they are
separate fingering digits over separate notes — the common case.

Confidence: "high" when certain, "medium" when probable, "low" when guessing.
Respond via the report_annotations tool for every cluster id and every run id.`;

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

    const ipRate = await checkRateLimit(`analyze-ip:${clientKey(req)}`, IP_LIMIT, WINDOW_MS);
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
    if (badImage(body.pageImage, MAX_PAGE_IMAGE_B64)) {
        return jsonResponse({ error: 'pageImage missing or over budget' }, 400);
    }
    const clusters = Array.isArray(body.clusters) ? body.clusters : [];
    if (clusters.length === 0 || clusters.length > MAX_CLUSTERS_PER_CALL) {
        return jsonResponse({ error: `clusters must be 1..${MAX_CLUSTERS_PER_CALL}` }, 400);
    }
    for (const cluster of clusters) {
        if (
            typeof cluster.id !== 'string' ||
            !Array.isArray(cluster.bbox) ||
            cluster.bbox.length !== 4 ||
            cluster.bbox.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
            badImage(cluster.crop, MAX_CROP_B64)
        ) {
            return jsonResponse({ error: 'Invalid cluster entry' }, 400);
        }
    }
    const runs = Array.isArray(body.runs) ? body.runs : [];
    const clusterIds = new Set(clusters.map((c) => c.id));
    for (const run of runs) {
        if (
            typeof run.id !== 'string' ||
            !Array.isArray(run.clusterIds) ||
            run.clusterIds.some((id) => !clusterIds.has(id))
        ) {
            return jsonResponse({ error: 'Invalid run entry' }, 400);
        }
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

    const userRate = await checkRateLimit(`analyze:${userId}`, USER_LIMIT, WINDOW_MS);
    if (!userRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: userRate.retryAfterSec }, 429);
    }

    const { data: role, error: roleError } = await userClient.rpc('document_role', { doc: documentId });
    if (roleError || role !== 'owner') {
        return jsonResponse({ error: 'Only the document owner can analyze a score' }, 403);
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
        // Not configured — tell the client to degrade to strokes-only, quietly.
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
                media_type: body.pageImage!.mediaType as 'image/jpeg',
                data: body.pageImage!.dataBase64!,
            },
        },
    ];
    for (const cluster of clusters) {
        const [x, y, w, h] = cluster.bbox;
        content.push({
            type: 'text',
            text:
                `Cluster ${cluster.id} — color ${cluster.colorHex}, at x=${x.toFixed(3)} y=${y.toFixed(3)} ` +
                `w=${w.toFixed(3)} h=${h.toFixed(3)}${cluster.runId ? `, run ${cluster.runId}` : ''}:`,
        });
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: cluster.crop.mediaType as 'image/jpeg',
                data: cluster.crop.dataBase64,
            },
        });
    }
    if (runs.length > 0) {
        content.push({
            type: 'text',
            text: `Runs to decide: ${runs.map((r) => `${r.id} = [${r.clusterIds.join(', ')}]`).join('; ')}`,
        });
    }

    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            output_config: { effort: 'low' },
            tools: [
                {
                    name: 'report_annotations',
                    description: 'Report the classification of every numbered handwriting cluster and run.',
                    strict: true,
                    input_schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['clusters', 'runs'],
                        properties: {
                            clusters: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['id', 'kind', 'confidence'],
                                    properties: {
                                        id: { type: 'string' },
                                        kind: {
                                            type: 'string',
                                            enum: ['digit', 'text', 'articulation', 'mark', 'noise'],
                                        },
                                        text: { type: 'string' },
                                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                                    },
                                },
                            },
                            runs: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['id', 'treatAsOneText'],
                                    properties: {
                                        id: { type: 'string' },
                                        treatAsOneText: { type: 'boolean' },
                                        text: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                },
            ],
            tool_choice: { type: 'tool', name: 'report_annotations', disable_parallel_tool_use: true },
            messages: [{ role: 'user', content }],
        });

        if (response.stop_reason === 'refusal') {
            return jsonResponse({ error: 'Recognition declined', code: 'ai_unavailable' }, 502);
        }
        const toolUse = response.content.find(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );
        if (!toolUse) {
            return jsonResponse({ error: 'No classification produced', code: 'ai_unavailable' }, 502);
        }
        const input = toolUse.input as {
            clusters?: { id: string; kind: string; text?: string; confidence: string }[];
            runs?: { id: string; treatAsOneText: boolean; text?: string }[];
        };

        // Sanity: only echo ids that were actually in the request.
        const runIds = new Set(runs.map((r) => r.id));
        const outClusters = (input.clusters ?? []).filter((c) => clusterIds.has(c.id));
        const outRuns = (input.runs ?? []).filter((r) => runIds.has(r.id));

        return jsonResponse({ ok: true, page, clusters: outClusters, runs: outRuns });
    } catch (err) {
        console.error('analyze-annotations model call failed', err);
        return jsonResponse({ error: 'Recognition unavailable', code: 'ai_unavailable' }, 502);
    }
});
