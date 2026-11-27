import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { compile, optimize } from '@tailwindcss/node';
import postcss, { type AtRule, type Container } from 'postcss';

/** Resolved from the project root: jsdom gives import.meta a non-file URL. */
const SRC = resolve(process.cwd(), 'src');

const compiler = compile(readFileSync(`${SRC}/index.css`, 'utf8'), {
    base: SRC,
    onDependency: () => {},
});

const REM_PX = 16;

const lengthPx = (value: string): number => {
    const [, amount, unit] = value.trim().match(/^([\d.]+)(rem|px)$/) ?? [];
    if (!amount) {
        throw new Error(`unsupported media length: ${value}`);
    }
    return unit === 'rem' ? Number(amount) * REM_PX : Number(amount);
};

const mediaMatches = (params: string, viewportWidth: number): boolean =>
    params.split(/\s+and\s+/).every((feature) => {
        const [, bound, length] = feature.match(/^\((min|max)-width:\s*([^)]+)\)$/) ?? [];
        if (!length) {
            return false;
        }
        return bound === 'min' ? viewportWidth >= lengthPx(length) : viewportWidth <= lengthPx(length);
    });

const inMatchingMedia = (node: Container, viewportWidth: number): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && (parent as AtRule).name === 'media') {
            if (!mediaMatches((parent as AtRule).params, viewportWidth)) {
                return false;
            }
        }
    }
    return true;
};

const matches = (element: Element, selector: string): boolean => {
    try {
        return element.matches(selector);
    } catch {
        return false;
    }
};

export const utilityStyleAt = async (
    element: Element,
    property: string,
    viewportWidth: number,
): Promise<string | undefined> => {
    const css = optimize((await compiler).build([...element.classList])).code;
    let value: string | undefined;
    postcss.parse(css).walkAtRules('layer', (layer) => {
        if (layer.params !== 'utilities') {
            return;
        }
        layer.walkRules((rule) => {
            if (!inMatchingMedia(rule, viewportWidth) || !matches(element, rule.selector)) {
                return;
            }
            rule.walkDecls(property, (decl) => {
                value = decl.value;
            });
        });
    });
    return value;
};
