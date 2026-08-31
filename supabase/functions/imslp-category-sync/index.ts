import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { COMPOSER_FACETS, ERA_FACETS, FORM_FACETS, INSTRUMENT_FACETS } from '../_shared/searchFacetData.ts';
import { checkRateLimit, clientKey, mwFetch, serviceClient } from '../_shared/imslp.ts';

/** MW pages per invoke — large categories resume via snapshot.resume_token. */
const PAGE_BUDGET = 30;

const taxonomyCategories = (): string[] => {
    const out: string[] = [];
    const add = (category?: string) => {
        if (category && !out.includes(category)) {
            out.push(category);
        }
        if (category?.startsWith('For ')) {
            const arr = `${category} (arr)`;
            if (!out.includes(arr)) {
                out.push(arr);
            }
        }
    };
    for (const facet of [...INSTRUMENT_FACETS, ...FORM_FACETS, ...ERA_FACETS, ...COMPOSER_FACETS]) {
        add(facet.category);
    }
    return out;
};

const fetchMemberPage = async (
    category: string,
    cmcontinue?: string,
): Promise<{ members: Array<{ title: string; pageid: number }>; cmcontinue?: string }> => {
    const params: Record<string, string> = {
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmnamespace: '0',
        cmtype: 'page',
        cmlimit: '50',
        cmsort: 'sortkey',
        cmdir: 'asc',
    };
    if (cmcontinue) {
        params['cmcontinue'] = cmcontinue;
    }
    const data = (await mwFetch(params)) as {
        query?: { categorymembers?: Array<{ title?: string; pageid?: number }> };
        continue?: { cmcontinue?: string };
    };
    const members = (data.query?.categorymembers ?? [])
        .filter((m): m is { title: string; pageid: number } => Boolean(m.title) && typeof m.pageid === 'number');
    return { members, cmcontinue: data.continue?.cmcontinue };
};

const syncCategory = async (category: string): Promise<{ category: string; status: string; memberCount: number }> => {
    const admin = serviceClient();
    if (!admin) {
        throw new Error('Service role is not configured');
    }

    const { data: existing } = await admin
        .from('imslp_category_snapshots')
        .select('resume_token, status')
        .eq('category', category)
        .maybeSingle();

    let resume = typeof existing?.resume_token === 'string' ? existing.resume_token : undefined;
    let pages = 0;
    let upserted = 0;

    while (pages < PAGE_BUDGET) {
        const { members, cmcontinue } = await fetchMemberPage(category, resume);
        pages += 1;
        if (members.length > 0) {
            const { error } = await admin.from('imslp_category_members').upsert(
                members.map((m) => ({
                    category,
                    page_title: m.title,
                    page_id: m.pageid,
                    last_seen_at: new Date().toISOString(),
                })),
                { onConflict: 'category,page_title' },
            );
            if (error) {
                throw error;
            }
            upserted += members.length;
        }
        resume = cmcontinue;
        if (!resume) {
            break;
        }
    }

    const { count } = await admin
        .from('imslp_category_members')
        .select('page_title', { count: 'exact', head: true })
        .eq('category', category);

    const status = resume ? 'partial' : 'ok';
    const { error: snapErr } = await admin.from('imslp_category_snapshots').upsert({
        category,
        status,
        member_count: count ?? upserted,
        resume_token: resume ?? null,
        synced_at: new Date().toISOString(),
    });
    if (snapErr) {
        throw snapErr;
    }
    return { category, status, memberCount: count ?? upserted };
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`category-sync:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { category?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const requested = typeof body.category === 'string' ? body.category.trim() : '';
    const allowed = taxonomyCategories();
    const category = requested || allowed[0] || '';
    if (!category || (requested && !allowed.includes(requested))) {
        return jsonResponse({ error: 'Unknown category' }, 400);
    }

    try {
        const result = await syncCategory(category);
        return jsonResponse(result);
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'Category sync failed' }, 502);
    }
});
