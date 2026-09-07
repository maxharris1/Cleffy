import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    applyPageResult,
    categoriesToSync,
    pickNextCategory,
    planTick,
    toWorkRow,
    walkCategoryBatch,
    type CategorySyncRow,
} from '../_shared/categorySync.ts';
import { mwFetch, serviceClient } from '../_shared/imslp.ts';
import {
    ALL_TAXONOMY_CATEGORIES,
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_BY_ID,
    INSTRUMENT_FACETS,
    KEY_FACETS,
} from '../_shared/searchFacetData.ts';

/**
 * Hosted refresh of the IMSLP works mirror. Deployed with verify_jwt = false
 * (see supabase/config.toml) because pg_cron / pg_net have no Supabase JWT —
 * the request is authenticated by x-imslp-sync-secret or a service-role bearer.
 *
 * Each tick walks one category for up to REQUESTS_PER_TICK MediaWiki calls:
 * generator batches of 500 pages (about four requests each — the taxonomy is
 * asked for in two clcategories chunks of 50), each page tagged with every
 * taxonomy category it belongs to, upserted into imslp_works. The category's sync row
 * rolls its generation over when the walk completes; pages the walk did not
 * see lose that category (imslp_prune_anchor). scripts/imslp-seed.ts runs the
 * same walk in one go for a cold environment.
 */

// ~60 requests at ~0.5s each plus the delay stays well under the edge wall clock.
const REQUESTS_PER_TICK = 60;
const REQUEST_DELAY_MS = 700;

// The search panel opens piano-scoped, so For piano is the first anchor.
const SYNC_CATEGORIES = categoriesToSync(
    COMPOSER_FACETS,
    INSTRUMENT_FACETS,
    FORM_FACETS,
    ERA_FACETS,
    KEY_FACETS,
    INSTRUMENT_BY_ID['piano']?.category,
);

const authorized = (req: Request): boolean => {
    const syncSecret = Deno.env.get('IMSLP_SYNC_SECRET');
    const headerSecret = req.headers.get('x-imslp-sync-secret');
    if (syncSecret && headerSecret && headerSecret === syncSecret) {
        return true;
    }
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const auth = req.headers.get('authorization') ?? '';
    if (serviceKey && auth === `Bearer ${serviceKey}`) {
        return true;
    }
    return false;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (!authorized(req)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    const { data: rows, error: loadError } = await admin.from('imslp_category_sync').select('*');
    if (loadError) {
        return jsonResponse({ error: loadError.message }, 500);
    }

    const existing = (rows ?? []) as CategorySyncRow[];
    const category = pickNextCategory(SYNC_CATEGORIES, existing);
    if (!category) {
        return jsonResponse({ ok: true, category: null, requests: 0 });
    }

    const previous = existing.find((r) => r.category === category);
    const plan = planTick(category, previous);
    const now = new Date().toISOString();
    // A resumed generation keeps its original start; a new one opens now.
    const buildingStartedAt = plan.cmcontinue && previous?.building_started_at ? previous.building_started_at : now;

    const { error: startError } = await admin.from('imslp_category_sync').upsert({
        category,
        state: 'building',
        active_generation: previous?.active_generation ?? 0,
        building_generation: plan.generation,
        building_started_at: buildingStartedAt,
        cmcontinue: plan.cmcontinue,
        pages_done: plan.pagesDone,
        last_error: null,
        completed_at: previous?.completed_at ?? null,
        updated_at: now,
    });
    if (startError) {
        return jsonResponse({ error: startError.message }, 500);
    }

    let cursor = plan.cmcontinue;
    let requestsSpent = 0;
    let pagesDone = plan.pagesDone;
    let lastDecision = applyPageResult(plan, previous, [], cursor ?? 'pending', null);

    try {
        while (requestsSpent < REQUESTS_PER_TICK) {
            if (requestsSpent > 0) {
                await sleep(REQUEST_DELAY_MS);
            }
            const batch = await walkCategoryBatch(mwFetch, {
                category,
                clcategories: ALL_TAXONOMY_CATEGORIES,
                gcmcontinue: cursor,
            });
            requestsSpent += batch.requests;
            if (batch.members.length > 0) {
                const seenAt = new Date().toISOString();
                const { error: writeError } = await admin.from('imslp_works').upsert(
                    batch.members.map((m) => toWorkRow(category, m, seenAt)),
                    { onConflict: 'page_id' },
                );
                if (writeError) {
                    throw new Error(writeError.message);
                }
            }
            const stepped = applyPageResult(
                { ...plan, pagesDone, cmcontinue: cursor },
                previous,
                batch.members,
                batch.gcmcontinue,
                null,
            );
            lastDecision = stepped;
            pagesDone = stepped.pagesDone;
            cursor = batch.gcmcontinue;
            if (stepped.kind !== 'continue') {
                break;
            }
        }
    } catch (err) {
        lastDecision = applyPageResult(
            { ...plan, pagesDone, cmcontinue: cursor },
            previous,
            [],
            cursor,
            err instanceof Error ? err.message : 'sync failed',
        );
    }

    const state = lastDecision.kind === 'complete' ? 'ok' : lastDecision.kind === 'failed' ? 'failed' : 'building';
    const { error: finishError } = await admin.from('imslp_category_sync').upsert({
        category,
        state,
        active_generation: lastDecision.activeGeneration,
        building_generation: lastDecision.buildingGeneration,
        building_started_at: buildingStartedAt,
        cmcontinue: lastDecision.cmcontinue,
        pages_done: lastDecision.pagesDone,
        last_error: lastDecision.lastError,
        completed_at: lastDecision.kind === 'complete' ? new Date().toISOString() : (previous?.completed_at ?? null),
        updated_at: new Date().toISOString(),
    });
    if (finishError) {
        return jsonResponse({ error: finishError.message }, 500);
    }

    // Rollover the sync row first so a failed prune cannot leave the mirror
    // serving from a generation the row no longer names.
    let pruned: number | null = null;
    if (lastDecision.kind === 'complete') {
        const { data } = await admin.rpc('imslp_prune_anchor', { anchor: category, before: buildingStartedAt });
        pruned = typeof data === 'number' ? data : null;
    }

    return jsonResponse({
        ok: lastDecision.kind !== 'failed',
        category,
        state,
        requests: requestsSpent,
        pagesDone: lastDecision.pagesDone,
        cmcontinue: lastDecision.cmcontinue,
        pruned,
    });
});
