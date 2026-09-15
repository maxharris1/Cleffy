import type { Meter } from './signals.js';
import type { WorkKey } from './types.js';
import { workKeyFromText } from './workKey.js';
import type { PdfLayout, PdfTextTok } from './pdfLayout.js';

const MAJOR_FIFTHS: Record<string, number> = {
    c: 0,
    g: 1,
    d: 2,
    a: 3,
    e: 4,
    b: 5,
    'f#': 6,
    'c#': 7,
    f: -1,
    bb: -2,
    eb: -3,
    ab: -4,
    db: -5,
    gb: -6,
    cb: -7,
};

const MINOR_FIFTHS: Record<string, number> = {
    a: 0,
    e: 1,
    b: 2,
    'f#': 3,
    'c#': 4,
    'g#': 5,
    'd#': 6,
    'a#': 7,
    d: -1,
    g: -2,
    c: -3,
    f: -4,
    bb: -5,
    eb: -6,
    ab: -7,
};

const fold = (text: string): string =>
    text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

const spell = (root: string, acc: string | undefined): string => {
    const r = root.toLowerCase();
    if (!acc) {
        return r;
    }
    const a = acc.toLowerCase();
    if (a === '#' || a === 'sharp' || a === 's') {
        return `${r}#`;
    }
    if (a === 'b' || a === 'flat') {
        return `${r}b`;
    }
    return r;
};

export const fifthsFromText = (text: string): number | null => {
    const folded = fold(text);
    const named = folded.match(
        /\b(?:in\s+)?([A-G])(?:\s*[-]?\s*(sharp|flat|#|b))?\s+(major|minor|maj|min)\b/i,
    );
    if (named?.[1]) {
        const key = spell(named[1], named[2]);
        const minor = /min/i.test(named[3] ?? '');
        const table = minor ? MINOR_FIFTHS : MAJOR_FIFTHS;
        return table[key] ?? null;
    }
    return null;
};

export const meterFromText = (text: string): Meter | null => {
    const folded = fold(text);
    const hit = folded.match(/\b(\d{1,2})\s*\/\s*(1|2|4|8|16)\b/);
    if (!hit?.[1] || !hit[2]) {
        return null;
    }
    const num = Number(hit[1]);
    const den = Number(hit[2]);
    if (num < 1 || num > 16) {
        return null;
    }
    return { num, den };
};

/** Stacked time-signature digits on the first system (LilyPond Mutopia). */
export const meterFromStackedDigits = (layout: PdfLayout): Meter | null => {
    const page = layout.pages[0];
    const sys = page?.systems[0];
    if (!page || !sys) {
        return null;
    }
    const xMin = sys.x0 + 8;
    const xMax = sys.barXs[1] ?? sys.x0 + 90;
    const yTop = sys.yTop + sys.yTop - sys.yBot;
    const yBot = sys.yBot - 8;
    const digits = page.text.filter(
        (t) => /^\d{1,2}$/.test(t.str.trim()) && t.x >= xMin && t.x <= xMax && t.y <= yTop && t.y >= yBot,
    );
    let best: Meter | null = null;
    let bestDy = 99;
    for (const a of digits) {
        for (const b of digits) {
            if (a === b) {
                continue;
            }
            const dx = Math.abs(a.x - b.x);
            const dy = Math.abs(a.y - b.y);
            if (dx > 10 || dy < 4 || dy > 22) {
                continue;
            }
            const top = a.y >= b.y ? a : b;
            const bot = a.y >= b.y ? b : a;
            const num = Number(top.str);
            const den = Number(bot.str);
            if (![1, 2, 4, 8, 16].includes(den) || num < 1 || num > 16) {
                continue;
            }
            if (dy < bestDy) {
                bestDy = dy;
                best = { num, den };
            }
        }
    }
    return best;
};

const headerWords = (layout: PdfLayout): string => {
    const page = layout.pages[0];
    if (!page) {
        return '';
    }
    const minY = page.height * 0.78;
    const words = page.text
        .filter((t: PdfTextTok) => t.y >= minY && /[A-Za-z0-9]/.test(t.str))
        .map((t) => t.str.trim())
        .filter((s) => s.length > 0);
    return words.join(' ');
};

const movementFromHeader = (text: string): number | undefined => {
    const no = text.match(/\b(?:No\.?|N[o°]|#)\s*(\d+)\b/i);
    if (no?.[1]) {
        return Number(no[1]);
    }
    return undefined;
};

export const workKeyFromPdfLayout = (layout: PdfLayout): WorkKey | null => {
    const blob = [
        layout.title,
        layout.subtitle,
        layout.composer,
        layout.author,
        headerWords(layout),
        layout.headerText,
    ]
        .filter((s) => s.length > 0)
        .join(' ');
    const key = workKeyFromText(blob);
    if (!key) {
        return null;
    }
    const composerId = key.catalogType === 'BWV' || key.catalogType === 'Anh' ? 'bach' : key.composerId;
    const withComposer = composerId === key.composerId ? key : { ...key, composerId };
    if (withComposer.movementIndex === undefined) {
        const movement = movementFromHeader(blob);
        if (movement !== undefined) {
            return { ...withComposer, movementIndex: movement };
        }
    }
    return withComposer;
};

export const meterFromPdfLayout = (layout: PdfLayout): Meter | null =>
    meterFromStackedDigits(layout) ?? meterFromText(`${layout.title} ${layout.subtitle} ${layout.headerText}`);

export const fifthsFromPdfLayout = (layout: PdfLayout): number | null =>
    fifthsFromText(`${layout.title} ${layout.subtitle} ${layout.composer} ${layout.author} ${layout.headerText}`);
