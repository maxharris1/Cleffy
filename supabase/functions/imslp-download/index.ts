import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, tryDownloadPdf } from '../_shared/imslp.ts';

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = checkRateLimit(`download:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { filename?: string; acceptedDisclaimer?: boolean };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
        return jsonResponse({ error: 'filename must be a .pdf' }, 400);
    }
    if (!body.acceptedDisclaimer) {
        return jsonResponse(
            {
                error: 'Copyright disclaimer must be accepted before download',
                code: 'disclaimer_required',
            },
            400,
        );
    }

    // Reject path traversal / unexpected characters in filenames.
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return jsonResponse({ error: 'Invalid filename' }, 400);
    }

    try {
        const result = await tryDownloadPdf(filename);
        if (!result.ok) {
            return jsonResponse(
                {
                    ok: false,
                    code: result.code,
                    message: result.message,
                    openUrl: result.openUrl,
                    filename: result.filename,
                },
                // 409 signals hybrid fallback to the client.
                409,
            );
        }

        return new Response(result.bytes, {
            status: 200,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${result.filename.replace(/"/g, '')}"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : 'IMSLP download failed' },
            502,
        );
    }
});
