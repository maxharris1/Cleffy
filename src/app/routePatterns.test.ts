import { readdirSync, readFileSync } from 'node:fs';
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

// The database keeps its own copy in public.web_route_patterns(): record_web_events
// drops an event, and the sign-up trigger nulls landing_path, for any path not in
// it. The newest migration that defines the function is the copy that counts.
const serverRoutePatterns = (): string[] => {
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const definitions = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => readFileSync(resolve(dir, name), 'utf8'))
        .map((sql) =>
            /function\s+public\.web_route_patterns\s*\(\s*\)[\s\S]*?\barray\s*\[([\s\S]*?)\]\s*::\s*text\[\]/i.exec(
                sql,
            ),
        )
        .filter((match): match is RegExpExecArray => match !== null);
    const latest = definitions.at(-1);
    if (!latest) {
        throw new Error('no migration defines public.web_route_patterns()');
    }
    return [...(latest[1] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));
};

describe('public.web_route_patterns()', () => {
    it('is ROUTE_PATTERNS: a new route needs a migration that redefines it', () => {
        expect(serverRoutePatterns().sort()).toEqual([...ROUTE_PATTERNS].sort());
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
