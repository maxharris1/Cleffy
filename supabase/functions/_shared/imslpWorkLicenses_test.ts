import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse } from './cors.ts';
import { resolveLicenses, type LicenseSpan } from './imslpWorkLicenses.ts';
import { withServerTiming } from './serverTiming.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const WORK = 'Second Rhapsody (Gershwin, George)';
const TWO_PIANOS = 'PMLP314974-Gershwin 2nd Rhapsody - 2 pianos.pdf';
const FULL_SCORE = 'PMLP314974-Gershwin - Second Rhapsody.pdf';
const SEEDED = 'PMLP314974-Seeded only in cache.pdf';

const workPageHtml = await Deno.readTextFile(
    new URL('../../../tests/imslp/fixtures/gershwin-second-rhapsody.html', import.meta.url),
);

interface Row {
    filename: string;
    license_label: string | null;
    restriction: string | null;
    eu_hosted: boolean;
    fetched_at: string;
}

const row = (filename: string, fetchedAt = new Date().toISOString()): Row => ({
    filename,
    license_label: 'Public Domain',
    restriction: 'Seeded restriction',
    eu_hosted: false,
    fetched_at: fetchedAt,
});

const fakeIo = (rows: Row[], html: string | null) => {
    const tables: string[] = [];
    const upserts: Record<string, unknown>[][] = [];
    const htmlFetches: string[] = [];
    const admin = {
        from: (table: string) => {
            tables.push(table);
            return {
                select: () => ({
                    in: (_column: string, filenames: string[]) =>
                        Promise.resolve({ data: rows.filter((r) => filenames.includes(r.filename)), error: null }),
                }),
                upsert: (written: Record<string, unknown>[]) => {
                    upserts.push(written);
                    return Promise.resolve({ data: null, error: null });
                },
            };
        },
    } as unknown as SupabaseClient;
    const fetchWorkPageHtml = (workTitle: string) => {
        htmlFetches.push(workTitle);
        return Promise.resolve(html);
    };
    return { admin, fetchWorkPageHtml, tables, upserts, htmlFetches };
};

const runWork = async (io: ReturnType<typeof fakeIo>, pdfTitles: string[]) => {
    let result: Awaited<ReturnType<typeof resolveLicenses>> | undefined;
    let res: Response | undefined;
    const handler = withServerTiming<LicenseSpan>('imslp-work', async (_req, timing) => {
        result = await resolveLicenses(
            { admin: io.admin, fetchWorkPageHtml: io.fetchWorkPageHtml, timing },
            WORK,
            pdfTitles,
        );
        return jsonResponse({ title: WORK, editions: pdfTitles });
    });
    const log = console.log;
    console.log = () => undefined;
    try {
        res = await handler(new Request('https://x.test/imslp-work', { method: 'POST' }));
    } finally {
        console.log = log;
    }
    const header = res!.headers.get('Server-Timing') ?? '';
    const spans = header.split(', ').map((entry) => entry.split(';dur=')[0]);
    return { result: result!, header, spans };
};

Deno.test('every file fresh in the cache: source cache, no page fetch, no upsert, only lic_db timed', async () => {
    const io = fakeIo([row(TWO_PIANOS), row(FULL_SCORE)], workPageHtml);
    const { result, spans, header } = await runWork(io, [TWO_PIANOS, FULL_SCORE]);

    assert(result.source === 'cache', result.source);
    assert(result.licenses.get(TWO_PIANOS)?.restriction === 'Seeded restriction');
    assert(result.licenses.size === 2);
    assert(io.htmlFetches.length === 0, `html fetches: ${io.htmlFetches.length}`);
    assert(io.upserts.length === 0, 'no upsert');
    assert(JSON.stringify(io.tables) === '["imslp_file_licenses"]', JSON.stringify(io.tables));
    assert(JSON.stringify(spans) === '["lic_db","total"]', header);
});

Deno.test('a stale and a missing row: one page parse, upsert only what the parse verified', async () => {
    const io = fakeIo([row(TWO_PIANOS, '2000-01-01T00:00:00Z'), row(SEEDED)], workPageHtml);
    const { result, spans, header } = await runWork(io, [TWO_PIANOS, FULL_SCORE, SEEDED]);

    assert(result.source === 'live', result.source);
    assert(JSON.stringify(io.htmlFetches) === JSON.stringify([WORK]), JSON.stringify(io.htmlFetches));
    assert(result.licenses.get(TWO_PIANOS)?.restriction === 'Non-PD US');
    assert(result.licenses.get(FULL_SCORE)?.euHosted === true);
    assert(result.licenses.get(SEEDED)?.restriction === 'Seeded restriction', 'seeded row kept');

    assert(io.upserts.length === 1, `upserts: ${io.upserts.length}`);
    const written = io.upserts[0]!;
    assert(
        JSON.stringify(written.map((r) => r.filename)) === JSON.stringify([TWO_PIANOS, FULL_SCORE]),
        JSON.stringify(written),
    );
    for (const r of written) {
        assert(r.work_title === WORK && r.restriction === 'Non-PD US' && r.downloadable === false, JSON.stringify(r));
    }
    assert(JSON.stringify(spans) === '["lic_db","lic_parse","lic_upsert","total"]', header);
});

Deno.test('the page fetch fails: source unavailable, fresh seeded rows kept, nothing written', async () => {
    const io = fakeIo([row(SEEDED)], null);
    const { result, spans, header } = await runWork(io, [SEEDED, FULL_SCORE]);

    assert(result.source === 'unavailable', result.source);
    assert(io.htmlFetches.length === 1);
    assert(result.licenses.size === 1 && result.licenses.get(SEEDED)?.restriction === 'Seeded restriction');
    assert(io.upserts.length === 0, 'no upsert');
    assert(JSON.stringify(spans) === '["lic_db","lic_parse","total"]', header);
});
