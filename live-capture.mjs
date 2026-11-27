import { open, audit, shot, close } from '/home/claude-bot/factory-work/jobs/6e80f4ca16be4c37854d0fd1c2d3be4c/repo/scripts/ui/uifuzz.mjs';
const BASE = process.env.CLEFFY_UI_BASE;
const REF = 'qdbnlrgylelelvwbkvnm';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const user = { id: '00000000-0000-4000-8000-000000000223', aud: 'authenticated', role: 'authenticated', email: 'teacher@example.test',
  app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Test Teacher' }, created_at: '2026-01-01T00:00:00Z' };
const jwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: user.id, exp: now + 3600, role: 'authenticated', aud: 'authenticated', email: user.email }), 'sig'].join('.');
const session = { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'fake-refresh', user };

const entitlements = { user_id: user.id, tier: 'teacher', status: 'active', source: 'subscription', current_period_end: '2027-01-01T00:00:00Z', cancel_at_period_end: false,
  limits: { cloud_scores: -1, omr_runs: -1, vision_reads: -1, smart_imports: -1, pdf_exports: -1, students: -1 } };
const cases = [
  { name: 'live-saving-640-L12R16T24', width: 640, insets: { top: 24, left: 12, right: 16, bottom: 0 } },
  { name: 'live-saving-640-L0R0', width: 640, insets: null },
  { name: 'live-saving-700-L0R0', width: 700, insets: null },
];
const report = {};
for (const c of cases) {
  const { page, context, consoleErrors } = await open('desktop-1440', { viewport: { width: c.width, height: 800 } });
  let hold = false;
  const seen = [];
  await context.route(`https://${REF}.supabase.co/**`, async (route) => {
    const req = route.request(); const u = new URL(req.url());
    seen.push(req.method() + ' ' + u.pathname);
    if (hold && u.pathname.startsWith('/auth/v1/token')) return; // never answer: keeps the pre-sign-out sync pending
    if (u.pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (u.pathname === '/rest/v1/rpc/library_bootstrap') return route.fulfill({ json: { documents: [], has_more: false, favorite_ids: [], tags: [], document_tags: [], entitlements } });
    if (u.pathname === '/rest/v1/rpc/get_entitlements') return route.fulfill({ json: entitlements });
    if (u.pathname.startsWith('/rest/v1/')) {
      const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ status: single ? 406 : 200, json: single ? { code: 'PGRST116', message: 'no rows' } : [], headers: { 'content-range': '*/0' } });
    }
    if (u.pathname.startsWith('/realtime/')) return route.abort();
    return route.fulfill({ json: {} });
  });
  await context.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, [`sb-${REF}-auth-token`, JSON.stringify(session)]);
  if (c.insets) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: c.insets });
  }
  await page.goto(BASE + '/search');
  await page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.expires_at = 1; localStorage.setItem(k, JSON.stringify(s)); }, `sb-${REF}-auth-token`);
  hold = true;
  const header = page.locator('header.shell-bar');
  await header.getByRole('button').last().click({ timeout: 5000 });
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('status').filter({ hasText: 'Saving changes…' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  const geo = await page.evaluate(() => {
    const h = document.querySelector('header');
    const pick = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; };
    const ctrls = { wordmark: h.querySelector('a[href="/library"]') };
    for (const a of h.querySelectorAll('nav[aria-label="Main"] a')) ctrls[a.textContent.trim()] = a;
    const btns = [...h.querySelectorAll('button')];
    ctrls['Upload score'] = h.querySelector('label.shell-upload');
    ctrls.avatar = btns.at(-1);
    const out = { vw: innerWidth, safeLeft: getComputedStyle(document.documentElement).getPropertyValue('--safe-left'), controls: {} };
    const entries = Object.entries(ctrls).filter(([, el]) => el);
    for (const [name, el] of entries) {
      const r = el.getBoundingClientRect(); const y = (r.top + r.bottom) / 2;
      const hitL = document.elementFromPoint(r.left + 1, y), hitR = document.elementFromPoint(r.right - 1, y);
      out.controls[name] = { ...pick(el), inside: r.left >= 0 && r.right <= innerWidth, hitLeftOwn: el.contains(hitL), hitRightOwn: el.contains(hitR) };
    }
    const overlaps = [];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i][1].getBoundingClientRect(), b = entries[j][1].getBoundingClientRect();
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(entries[i][0] + '/' + entries[j][0]);
    }
    out.overlaps = overlaps;
    const st = [...document.querySelectorAll('[role=status]')].find((s) => s.textContent.includes('Saving changes'));
    out.status = { ...pick(st), color: getComputedStyle(st).color, visible: st.checkVisibility() };
    return out;
  });
  geo.audit = await audit(page);
  report[c.name] = geo;
  console.log(`${c.name} -> ${await shot(page, c.name)}  vw=${geo.vw} --safe-left=${geo.safeLeft}`);
  for (const [n, g] of Object.entries(geo.controls)) console.log(`  ${n.padEnd(13)} x ${g.l}-${g.r} y ${g.t}-${g.b} inside=${g.inside} hit1pxL=${g.hitLeftOwn} hit1pxR=${g.hitRightOwn}`);
  console.log(`  overlaps=${JSON.stringify(geo.overlaps)} status "Saving changes…" x ${geo.status.l}-${geo.status.r} y ${geo.status.t}-${geo.status.b} visible=${geo.status.visible} color=${geo.status.color}`);
  console.log(`  uifuzz audit: ${JSON.stringify(geo.audit).slice(0, 400)}`);
  if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5));
  await context.close();
}
await close();
