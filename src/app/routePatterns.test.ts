import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTE_PATTERNS, routePatternOf } from '@/app/routePatterns';

describe('ROUTE_PATTERNS', () => {
    it('is every path routes.tsx declares', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/app/routes.tsx'), 'utf8');
        const declared = [...source.matchAll(/\bpath="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
        expect([...ROUTE_PATTERNS].sort()).toEqual([...new Set(declared)].sort());
    });
});

describe('routePatternOf', () => {
    it('names the matched pattern, never the value in it', () => {
        expect(routePatternOf('/join/abc123')).toBe('/join/:token');
        expect(routePatternOf('/doc/0b6f6a0e-1b1c-4b8e-9f39-0e8c2f7b1a11')).toBe('/doc/:documentId');
        expect(routePatternOf('/try')).toBe('/try');
        expect(routePatternOf('/try/')).toBe('/try');
        expect(routePatternOf('/')).toBe('/');
    });

    it('reports an unknown path as *', () => {
        expect(routePatternOf('/reset/some-secret')).toBe('*');
        expect(routePatternOf('/try/extra')).toBe('*');
    });
});
