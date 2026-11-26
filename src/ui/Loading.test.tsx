import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LoadingText } from '@/ui/Loading';

afterEach(cleanup);

const INDEX_CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const hex = (name: string) => {
    const value = INDEX_CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    expect(value, `--color-${name} is not a hex colour in src/index.css`).toBeDefined();
    return value ?? '';
};

const luminance = (color: string) => {
    const channel = (i: number) => {
        const v = parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
};

const contrast = (a: string, b: string) => {
    const [la, lb] = [luminance(a), luminance(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

describe('LoadingText', () => {
    it('pulses its colour, never its opacity, so it never fades below text contrast', () => {
        render(<LoadingText>Opening score…</LoadingText>);
        const text = screen.getByRole('status');
        expect(text.className).not.toMatch(/\banimate-pulse\b/);
        expect(text).toHaveClass('animate-loading-pulse');
        const keyframes = INDEX_CSS.match(/@keyframes loading-pulse\s*{([\s\S]*?)\n}/)?.[1] ?? '';
        expect(keyframes).not.toBe('');
        expect(keyframes).not.toMatch(/opacity/);
    });

    it('keeps 4.5:1 on paper at every colour of the pulse', () => {
        const keyframes = INDEX_CSS.match(/@keyframes loading-pulse\s*{([\s\S]*?)\n}/)?.[1] ?? '';
        const stops = [...keyframes.matchAll(/var\(--color-([\w-]+)\)/g)].map((m) => m[1] ?? '');
        expect(stops.length).toBeGreaterThan(0);
        for (const stop of stops) {
            expect(contrast(hex(stop), hex('paper')), stop).toBeGreaterThanOrEqual(4.5);
        }
    });
});
