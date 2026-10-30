import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return sourceFiles(path);
        }
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

describe('VITE_ variable reads', () => {
    it('names every variable outright, so the build inlines only what is read', () => {
        // A computed-key read of import.meta.env makes Vite inline the whole env
        // object, every VITE_ variable the build has, wherever it appears.
        const offenders = sourceFiles(join(process.cwd(), 'src')).filter((path) =>
            /import\.meta\.env\s*\[/.test(readFileSync(path, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });
});
