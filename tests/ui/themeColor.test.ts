import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('browser chrome colour', () => {
    it('matches the paper header, in the page and in the PWA manifest alike', () => {
        const paper = read('src/index.css').match(/--color-paper:\s*(#[0-9a-f]{6})/i)?.[1];
        const meta = read('index.html').match(/<meta name="theme-color" content="(#[0-9a-f]{6})"/i)?.[1];
        const manifest = read('vite.config.ts').match(/theme_color:\s*'(#[0-9a-f]{6})'/i)?.[1];
        expect(paper).toBeDefined();
        expect(meta?.toLowerCase()).toBe(paper?.toLowerCase());
        expect(manifest?.toLowerCase()).toBe(paper?.toLowerCase());
    });
});
