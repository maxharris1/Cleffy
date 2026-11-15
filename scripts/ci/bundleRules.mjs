/**
 * Rules for the production bundle (Share v2, #105). fake-indexeddb backs the
 * signed-out link viewer's in-memory database and must never reach a member:
 * it may sit only in the /s viewer chunk (or chunks only it loads), never in
 * the entry or anything the entry imports statically, and that chunk stays
 * within its gzip budget.
 *
 * `report.chunks` maps a chunk file name to
 * { isEntry, imports: string[], dynamicImports: string[], modules: string[] }.
 */

export const VIEWER_MODULE = /src\/features\/share\/LinkViewerPage\.tsx$/;
export const GUARDED_MODULE = /node_modules\/fake-indexeddb\//;
/** First build at 17.4 kB gzip, plus 15%. */
export const VIEWER_GZIP_BUDGET = 20_500;

/** Chunks reached from `roots` by static imports (and dynamic ones when `dynamic`), never entering `skip`. */
const walk = (chunks, roots, { dynamic, skip = null }) => {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        const name = stack.pop();
        if (seen.has(name) || name === skip || !chunks[name]) {
            continue;
        }
        seen.add(name);
        stack.push(...chunks[name].imports, ...(dynamic ? chunks[name].dynamicImports : []));
    }
    return seen;
};

/** Every broken rule, as a sentence; empty when the bundle is fine. */
export const bundleProblems = (report, gzipSizeOf) => {
    const { chunks } = report;
    const names = Object.keys(chunks);
    const viewer = names.find((name) => chunks[name].modules.some((id) => VIEWER_MODULE.test(id)));
    if (!viewer) {
        return ['No chunk holds src/features/share/LinkViewerPage.tsx: the /s viewer is not its own lazy chunk.'];
    }
    const problems = [];
    const entries = names.filter((name) => chunks[name].isEntry);
    const eager = walk(chunks, entries, { dynamic: false });
    if (eager.has(viewer)) {
        problems.push(`The /s viewer chunk ${viewer} loads with the entry.`);
    }
    const fromViewer = walk(chunks, [viewer], { dynamic: true });
    const withoutViewer = walk(chunks, entries, { dynamic: true, skip: viewer });
    for (const name of names) {
        if (!chunks[name].modules.some((id) => GUARDED_MODULE.test(id))) {
            continue;
        }
        if (eager.has(name)) {
            problems.push(`fake-indexeddb is in ${name}, which loads with the entry.`);
        } else if (!fromViewer.has(name) || withoutViewer.has(name)) {
            problems.push(`fake-indexeddb is in ${name}, outside the /s viewer chunk.`);
        }
    }
    const size = gzipSizeOf(viewer);
    if (size > VIEWER_GZIP_BUDGET) {
        problems.push(`The /s viewer chunk is ${size} bytes gzipped, over its ${VIEWER_GZIP_BUDGET}-byte budget.`);
    }
    return problems;
};
