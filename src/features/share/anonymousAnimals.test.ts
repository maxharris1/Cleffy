import { describe, expect, it } from 'vitest';

import { ANIMALS, animalFor, anonymousName } from './anonymousAnimals';

describe('anonymous animals', () => {
    it('has about sixty distinct animals', () => {
        expect(ANIMALS.length).toBeGreaterThanOrEqual(60);
        expect(new Set(ANIMALS).size).toBe(ANIMALS.length);
    });

    it('gives the same id the same animal every time', () => {
        const id = '7d3c0f6e-0d1c-4b8a-9a64-2f0c9e1d5b11';
        expect(animalFor(id)).toBe(animalFor(id));
        expect(anonymousName(id)).toBe(`Anonymous ${animalFor(id)}`);
    });

    it('spreads 1,000 ids over the list without piling onto a few', () => {
        const counts = new Map<string, number>();
        for (let i = 0; i < 1000; i++) {
            const a = animalFor(crypto.randomUUID());
            counts.set(a, (counts.get(a) ?? 0) + 1);
        }
        expect(counts.size).toBeGreaterThan(ANIMALS.length * 0.8);
        expect(Math.max(...counts.values())).toBeLessThan(45);
    });
});
