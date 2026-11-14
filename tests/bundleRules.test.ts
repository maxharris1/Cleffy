import { describe, expect, it } from 'vitest';

import { bundleProblems, VIEWER_GZIP_BUDGET } from '../scripts/ci/bundleRules.mjs';

const FAKE = '/repo/node_modules/fake-indexeddb/build/esm/index.js';
const VIEWER = '/repo/src/features/share/LinkViewerPage.tsx';

type Chunk = { isEntry: boolean; imports: string[]; dynamicImports: string[]; modules: string[] };
const chunk = (over: Partial<Chunk> = {}): Chunk => ({
    isEntry: false,
    imports: [],
    dynamicImports: [],
    modules: [],
    ...over,
});
const small = () => 1000;

const good = (): Record<string, Chunk> => ({
    'index.js': chunk({ isEntry: true, dynamicImports: ['ShareLinkPage.js'] }),
    'ShareLinkPage.js': chunk({ dynamicImports: ['LinkViewerPage.js'] }),
    'LinkViewerPage.js': chunk({ modules: [VIEWER, FAKE] }),
});

describe('bundleProblems', () => {
    it('passes fake-indexeddb in the lazy /s viewer chunk', () => {
        expect(bundleProblems({ chunks: good() }, small)).toEqual([]);
    });

    it('fails fake-indexeddb in the entry or a chunk it imports statically', () => {
        const chunks = good();
        chunks['index.js'] = chunk({ isEntry: true, imports: ['vendor.js'], dynamicImports: ['ShareLinkPage.js'] });
        chunks['vendor.js'] = chunk({ modules: [FAKE] });
        expect(bundleProblems({ chunks }, small)).toEqual([
            'fake-indexeddb is in vendor.js, which loads with the entry.',
        ]);
    });

    it('fails fake-indexeddb in a chunk other pages load too', () => {
        const chunks = good();
        chunks['LinkViewerPage.js'] = chunk({ modules: [VIEWER], imports: ['shared.js'] });
        chunks['shared.js'] = chunk({ modules: [FAKE] });
        chunks['index.js'] = chunk({ isEntry: true, dynamicImports: ['ShareLinkPage.js', 'Library.js'] });
        chunks['Library.js'] = chunk({ imports: ['shared.js'] });
        expect(bundleProblems({ chunks }, small)).toEqual([
            'fake-indexeddb is in shared.js, outside the /s viewer chunk.',
        ]);
    });

    it('passes a split chunk only the viewer loads', () => {
        const chunks = good();
        chunks['LinkViewerPage.js'] = chunk({ modules: [VIEWER], imports: ['fake.js'] });
        chunks['fake.js'] = chunk({ modules: [FAKE] });
        expect(bundleProblems({ chunks }, small)).toEqual([]);
    });

    it('fails when the viewer has no chunk of its own, or is over budget', () => {
        const chunks = good();
        expect(bundleProblems({ chunks }, () => VIEWER_GZIP_BUDGET + 1)).toEqual([
            `The /s viewer chunk is ${VIEWER_GZIP_BUDGET + 1} bytes gzipped, over its ${VIEWER_GZIP_BUDGET}-byte budget.`,
        ]);
        delete chunks['LinkViewerPage.js'];
        expect(bundleProblems({ chunks }, small)[0]).toMatch(/not its own lazy chunk/);
    });
});
