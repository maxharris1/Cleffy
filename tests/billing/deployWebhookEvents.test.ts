import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const handled = [...read('supabase/functions/_shared/stripeEvents.ts').matchAll(/case '([a-z_.]+)':/g)].map(
    (match) => match[1],
);

const section = (() => {
    const deploy = read('DEPLOY.md');
    const heading = '### Stripe webhook events';
    const start = deploy.indexOf(heading);
    if (start === -1) return '';
    const rest = deploy.slice(start + heading.length);
    const end = rest.search(/^#{2,3} /m);
    return end === -1 ? rest : rest.slice(0, end);
})();

const bulletedEvents = new Set([...section.matchAll(/^- `([a-z_.]+)`/gm)].map((match) => match[1]));

describe('DEPLOY.md Stripe webhook events', () => {
    it('extracts handled and bulleted event types', () => {
        expect(handled.length).toBeGreaterThan(0);
        expect(bulletedEvents.size).toBeGreaterThan(0);
    });

    it.each(handled)('lists %s', (type) => {
        expect(bulletedEvents).toContain(type);
    });
});
