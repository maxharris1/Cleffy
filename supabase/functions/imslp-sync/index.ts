import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    applyPageResult,
    categoriesToSync,
    parseMemberPage,
    pickNextCategory,
    planTick,
    type CategorySyncRow,
    type MemberPageResult,
} from '../_shared/categorySync.ts';
import { mwFetch, serviceClient } from '../_shared/imslp.ts';
import {
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_BY_ID,
    INSTRUMENT_FACETS,
} from '../_shared/searchFacetData.ts';

/**
 * Hosted IMSLP category-index refresh. Deployed with verify_jwt = false
 * (see supabase/config.toml) because pg_cron / pg_net have no Supabase JWT —
 * the request is authenticated by x-imslp-sync-secret or a service-role bearer.
 *
 * Each tick pages one category (up to 50 MW pages of 500 at ~1 req/s) into a
 * building generation. The previous ok snapshot stays live until the pager
 * finishes.
 */

const PAGES_PER_TICK = 50;
const PAGE_DELAY_MS = 1000;
// IMSLP serves the anonymous maximum of 500 per page; 50 would take ~5 hours
// to walk the taxonomy on the 2-minute cron.
const CM_LIMIT = 500;

// The search panel opens piano-scoped, so For piano gates every chip browse.
const SYNC_CATEGORIES = categoriesToSync(
    COMPOSER_FACETS,
    INSTRUMENT_FACETS,
    FORM_FACETS,
    ERA_FACETS,
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

const fetchMemberPage = async (category: string, cmcontinue: string | null): Promise<MemberPageResult> => {
    const params: Record<string, string> = {
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmnamespace: '0',
        cmtype: 'page',
        cmprop: 'title|ids|sortkeyprefix|timestamp',
        cmlimit: String(CM_LIMIT),
    };
    if (cmcontinue) {
        params['cmcontinue'] = cmcontinue;
    }
    return parseMemberPage(await mwFetch(params));
};

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
        return jsonResponse({ ok: true, category: null, pages: 0 });
    }

    const previous = existing.find((r) => r.category === category);
    const plan = planTick(category, previous);
    const now = new Date().toISOString();

    const { error: startError } = await admin.from('imslp_category_sync').upsert({
        category,
        state: 'building',
        active_generation: previous?.active_generation ?? 0,
        building_generation: plan.generation,
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
    let pagesFetched = 0;
    let pagesDone = plan.pagesDone;
    let lastDecision = applyPageResult(plan, previous, [], cursor ?? 'pending', null);

    try {
        for (let i = 0; i < PAGES_PER_TICK; i++) {
            if (i > 0) {
                await sleep(PAGE_DELAY_MS);
            }
            const { members, cmcontinue } = await fetchMemberPage(category, cursor);
            pagesFetched += 1;
            if (members.length > 0) {
                const { error: writeError } = await admin.from('imslp_category_members').upsert(
                    members.map((m) => ({
                        category,
                        page_title: m.title,
                        page_id: m.pageid,
                        sort_key: m.sortkeyprefix ?? null,
                        touched: m.timestamp ?? null,
                        generation: plan.generation,
                    })),
                    { onConflict: 'category,generation,page_title' },
                );
                if (writeError) {
                    throw new Error(writeError.message);
                }
            }
            const stepped = applyPageResult(
                { ...plan, pagesDone, cmcontinue: cursor },
                previous,
                members,
                cmcontinue,
                null,
            );
            lastDecision = stepped;
            pagesDone = stepped.pagesDone;
            cursor = cmcontinue;
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

    if (lastDecision.kind === 'complete' && lastDecision.deleteGenerationsBefore !== null) {
        await admin
            .from('imslp_category_members')
            .delete()
            .eq('category', category)
            .lt('generation', lastDecision.deleteGenerationsBefore);
    }

    const state = lastDecision.kind === 'complete' ? 'ok' : lastDecision.kind === 'failed' ? 'failed' : 'building';
    const { error: finishError } = await admin.from('imslp_category_sync').upsert({
        category,
        state,
        active_generation: lastDecision.activeGeneration,
        building_generation: lastDecision.buildingGeneration,
        cmcontinue: lastDecision.cmcontinue,
        pages_done: lastDecision.pagesDone,
        last_error: lastDecision.lastError,
        completed_at: lastDecision.kind === 'complete' ? new Date().toISOString() : (previous?.completed_at ?? null),
        updated_at: new Date().toISOString(),
    });
    if (finishError) {
        return jsonResponse({ error: finishError.message }, 500);
    }

    return jsonResponse({
        ok: lastDecision.kind !== 'failed',
        category,
        state,
        pages: pagesFetched,
        pagesDone: lastDecision.pagesDone,
        cmcontinue: lastDecision.cmcontinue,
    });
});
