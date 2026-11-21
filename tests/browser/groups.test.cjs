// Browser test: a User sees their role per group, creates a group, and administers it.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.TRIPSPLIT_BASE || 'http://localhost:8766/';
const MOCK = fs.readFileSync(path.join(__dirname, 'stand-in-supabase.mjs'), 'utf8');
const G = '00000000-0000-4000-8000-000000000001', F = 'frank@example.com', E = 'eric@ericdejager.com';
const seed = { groups: [{ id: G, name: 'Sailing test', created_at: '2026-11-01T00:00:00Z' }],
  group_members: [{ group_id: G, email: E, role: 'admin', added_at: '2026-11-01' }, { group_id: G, email: F, role: 'user', added_at: '2026-11-02' }],
  invitations: [], parties: [{ id: '00000000-0000-4000-8000-000000000012', group_id: G, name: 'Frank Forte', email: F, color: 1, payment: {} }],
  trips: [], entries: [], categories: [] };
let failures = 0;
const check = (l, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${x ? ' — ' + x : ''}`); if (!c) failures++; };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route('**/@supabase/supabase-js@*/**', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.addInitScript(([db, me]) => { window.__db = db; window.__me = me; try { for (const k of Object.keys(localStorage)) {} } catch {} }, [seed, F]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto(BASE); await p.waitForTimeout(1500);
  // skip the one-time details screen if it shows
  if (await p.locator('text=Skip for now').count()) { await p.click('text=Skip for now'); await p.waitForTimeout(400); }
  await p.click('[data-action="go"][data-screen="trips"] >> nth=0').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-action="go"][data-screen="access"] >> nth=0'); await p.waitForTimeout(400);
  const row = p.locator('.access-row', { hasText: 'Sailing test' });
  check('User sees their role on the group', /User · Open now/.test(await row.innerText()));
  check('No Rename/Delete on a group where you are a User', (await row.locator('[data-action="editGroup"], [data-action="deleteGroup"]').count()) === 0);
  await p.fill('[data-newgroup]', 'Forte family'); await p.click('[data-action="newGroup"]'); await p.waitForTimeout(1200);
  const db = await p.evaluate(() => window.__db);
  const ng = db.groups.find((g) => g.name === 'Forte family');
  check('User creates a group and is its Administrator', !!ng && db.group_members.some((m) => m.group_id === ng.id && m.email === F && m.role === 'admin'));
  check('Created message', /Forte family created\. You’re its Administrator\./.test(await p.locator('body').innerText()));
  if (await p.locator('text=Skip for now').count()) { await p.click('text=Skip for now'); await p.waitForTimeout(400); }
  await p.click('[data-action="go"][data-screen="access"] >> nth=0'); await p.waitForTimeout(400);
  const nrow = p.locator('.access-row', { hasText: 'Forte family' });
  check('New group shows Administrator with Rename and Delete', /Administrator/.test(await nrow.innerText()) && (await nrow.locator('[data-action="editGroup"]').count()) === 1 && (await nrow.locator('[data-action="deleteGroup"]').count()) === 1);
  check('Old group still read-only for Frank', (await p.locator('.access-row', { hasText: 'Sailing test' }).locator('[data-action="editGroup"]').count()) === 0);
  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures ? 1 : 0);
})();
