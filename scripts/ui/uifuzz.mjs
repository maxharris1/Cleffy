// Responsive-layout check helper for agents and humans. See .claude/skills/ui-check/SKILL.md.
//
//   import { open, login, audit, shot, close } from '/abs/path/to/scripts/ui/uifuzz.mjs';
//   const { page, consoleErrors } = await open('iphone-se');
//   await login(page);                       // teacher; lands on /library
//   console.log(await audit(page), await shot(page, 'library-iphone-se'));
//   await close();
//
// Needs the app running (`npm run cloud:up`). Playwright is not a project
// dependency: this resolves it from the project if present, else from the
// global install cloud containers ship (/opt/node-tools, browsers in
// $PLAYWRIGHT_BROWSERS_PATH). Never run `playwright install` in the sandbox.
import { createRequire } from 'module';

const requirePlaywright = () => {
    const roots = [import.meta.url, '/opt/node-tools/node_modules/', '/opt/node22/lib/node_modules/'];
    for (const root of roots) {
        try {
            return createRequire(root)('playwright');
        } catch {
            // try the next root
        }
    }
    throw new Error('playwright not found: npm i -g playwright (browsers are preinstalled in cloud sessions)');
};
const { chromium } = requirePlaywright();

export const BASE = process.env.CLEFFY_UI_BASE ?? 'http://localhost:5173';
export const SHOTS = process.env.CLEFFY_UI_SHOTS ?? '/tmp/cleffy-ui/shots';

export const VIEWPORTS = {
    'desktop-1440': { viewport: { width: 1440, height: 900 } },
    'laptop-1280': { viewport: { width: 1280, height: 720 } },
    'ipad-landscape': { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    'ipad-portrait': { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    'ipad-mini-portrait': {
        viewport: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
    },
    'iphone-14': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    'iphone-se': { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    'android-small': { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    'iphone-landscape': { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

export const ACCOUNTS = {
    teacher: { email: 'teacher@cleffy.local', password: 'cleffy-local-test' },
    student: { email: 'student@cleffy.local', password: 'cleffy-local-test' },
};

let browser;
/** Returns { browser, context, page, consoleErrors } for a named viewport. */
export async function open(viewportName, opts = {}) {
    // The project's own Playwright may be newer than the browsers cached in the
    // container; fall back to the preinstalled Chromium rather than downloading.
    browser ??= await chromium
        .launch()
        .catch(() =>
            chromium.launch({ executablePath: process.env.CLEFFY_UI_CHROMIUM ?? '/opt/pw-browsers/chromium' }),
        );
    const context = await browser.newContext({ ...VIEWPORTS[viewportName], ...opts });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    return { browser, context, page, consoleErrors };
}

export async function close() {
    await browser?.close();
    browser = undefined;
}

/** Teacher login via /login. Students sign in at /student, which has its own form. */
export async function login(page, role = 'teacher') {
    const a = ACCOUNTS[role];
    await page.goto(BASE + '/login');
    await page.fill('#login-email', a.email);
    await page.fill('#login-password', a.password);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
    await page.waitForTimeout(800);
}

export async function shot(page, name) {
    const fs = await import('fs');
    fs.mkdirSync(SHOTS, { recursive: true });
    const path = `${SHOTS}/${name.replace(/[^a-z0-9._-]+/gi, '_')}.png`;
    await page.screenshot({ path, fullPage: false });
    return path;
}

/**
 * Heuristic layout audit of the current page. Returns a list of suspicious
 * findings — candidates only; confirm each by looking at a screenshot.
 */
export async function audit(page) {
    return page.evaluate(() => {
        const out = [];
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const desc = (el) => {
            const id = el.id ? '#' + el.id : '';
            const cls =
                typeof el.className === 'string' && el.className
                    ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
                    : '';
            const txt = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40);
            return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
        };
        const visible = (el) => {
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return (
                s.visibility !== 'hidden' &&
                s.display !== 'none' &&
                +s.opacity > 0.05 &&
                r.width > 2 &&
                r.height > 2 &&
                !el.closest('.sr-only')
            );
        };

        if (document.documentElement.scrollWidth > vw + 1)
            out.push({
                kind: 'page-horizontal-overflow',
                detail: `scrollWidth ${document.documentElement.scrollWidth} > ${vw}`,
            });

        const all = [...document.body.querySelectorAll('*')].filter(visible);
        for (const el of all) {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            // Sticks out of the viewport horizontally (and isn't inside a scroller).
            if ((r.right > vw + 1 || r.left < -1) && s.position !== 'fixed') {
                let p = el.parentElement,
                    inScroller = false;
                while (p && p !== document.body) {
                    const ps = window.getComputedStyle(p);
                    if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) {
                        inScroller = true;
                        break;
                    }
                    p = p.parentElement;
                }
                if (!inScroller && el.children.length === 0)
                    out.push({ kind: 'offscreen-x', el: desc(el), rect: [r.left, r.right].map(Math.round) });
            }
            // Clipped text: content wider than the box with overflow hidden and no ellipsis.
            if (
                el.children.length === 0 &&
                el.innerText?.trim() &&
                (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) &&
                /(hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY) &&
                s.textOverflow !== 'ellipsis' &&
                !/-webkit-box/.test(s.display)
            )
                out.push({ kind: 'clipped-text', el: desc(el) });
        }

        // Interactive elements: small tap targets, overlaps, things covered by something else.
        const ia = [
            ...document.querySelectorAll(
                'button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem]',
            ),
        ].filter(visible);
        const touch = window.matchMedia('(pointer: coarse)').matches;
        for (const el of ia) {
            const r = el.getBoundingClientRect();
            if (touch && (r.width < 32 || r.height < 32) && el.type !== 'checkbox' && el.type !== 'radio')
                out.push({ kind: 'small-tap-target', el: desc(el), size: [r.width, r.height].map(Math.round) });
            if (r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw) {
                const cx = r.left + r.width / 2,
                    cy = r.top + r.height / 2;
                const hit = document.elementFromPoint(cx, cy);
                if (hit && hit !== el && !el.contains(hit) && !hit.contains(el))
                    out.push({ kind: 'obscured', el: desc(el), coveredBy: desc(hit) });
            }
        }
        for (let i = 0; i < ia.length; i++)
            for (let j = i + 1; j < ia.length; j++) {
                const a = ia[i].getBoundingClientRect(),
                    b = ia[j].getBoundingClientRect();
                if (ia[i].contains(ia[j]) || ia[j].contains(ia[i])) continue;
                const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (ox > 4 && oy > 4) out.push({ kind: 'overlapping-controls', a: desc(ia[i]), b: desc(ia[j]) });
            }
        return out.slice(0, 80);
    });
}
