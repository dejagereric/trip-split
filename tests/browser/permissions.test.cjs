// Browser test: the app as a User and as an Administrator, against the stand-in Supabase.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const MOCK = fs.readFileSync(path.join(__dirname, 'stand-in-supabase.mjs'), 'utf8');
const BASE = process.env.TRIPSPLIT_BASE || 'http://localhost:8766/';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = id(1), PE = id(11), PF = id(12), PP = id(13), T1 = id(21), T2 = id(22), T3 = id(23);
const E = 'eric@ericdejager.com', F = 'frank@example.com';
const seed = () => ({
  groups: [{ id: G, name: 'Sailing test', created_at: '2026-11-01T00:00:00Z' }],
  group_members: [{ group_id: G, email: E, role: 'admin', added_at: '2026-11-01' }, { group_id: G, email: F, role: 'user', added_at: '2026-11-02' }],
  invitations: [],
  parties: [
    { id: PE, group_id: G, name: 'Eric de Jager', email: E, color: 0, payment: {}, created_at: '2026-11-01' },
    { id: PF, group_id: G, name: 'Frank Forte', email: F, color: 1, payment: {}, created_at: '2026-11-01' },
    { id: PP, group_id: G, name: 'Paul Martin', email: null, color: 2, payment: {}, created_at: '2026-11-01' }],
  trips: [
    { id: T1, group_id: G, name: 'Sardinia', currency: 'USD', currencies: ['USD', 'EUR'], member_ids: [PE, PF], weights: {}, default_split: 'equal', created_by_email: E, created_at: '2026-11-03T00:00:00Z', inactive_at: null, default_for_email: null },
    { id: T2, group_id: G, name: 'Frank shared trip', currency: 'USD', currencies: ['USD'], member_ids: [PF, PE], weights: {}, default_split: 'equal', created_by_email: F, created_at: '2026-11-02T00:00:00Z', inactive_at: null, default_for_email: null },
    { id: T3, group_id: G, name: 'Frank solo trip', currency: 'USD', currencies: ['USD'], member_ids: [PF], weights: {}, default_split: 'equal', created_by_email: F, created_at: '2026-11-01T00:00:00Z', inactive_at: null, default_for_email: null }],
  entries: [
    { id: id(31), group_id: G, trip_id: T1, kind: 'expense', description: 'Harbor dinner', category: 'Food', spent_on: '2026-11-10', amount_cents: 10000, payer: PE, shares: { [PE]: 5000, [PF]: 5000 }, split_mode: 'equal', created_by_email: E, created_at: '2026-11-10T10:00:00Z' },
    { id: id(32), group_id: G, trip_id: T1, kind: 'expense', description: 'Airport taxi', category: 'Fuel', spent_on: '2026-11-11', amount_cents: 6000, payer: PF, shares: { [PE]: 3000, [PF]: 3000 }, split_mode: 'equal', created_by_email: F, created_at: '2026-11-11T10:00:00Z' },
    { id: id(33), group_id: G, trip_id: T2, kind: 'expense', description: 'Groceries', category: 'Food', spent_on: '2026-11-12', amount_cents: 4000, payer: PE, shares: { [PE]: 2000, [PF]: 2000 }, split_mode: 'equal', created_by_email: E, created_at: '2026-11-12T10:00:00Z' },
    { id: id(34), group_id: G, trip_id: T3, kind: 'expense', description: 'Fuel stop', category: 'Fuel', spent_on: '2026-11-13', amount_cents: 3000, payer: PF, shares: { [PF]: 3000 }, split_mode: 'equal', created_by_email: F, created_at: '2026-11-13T10:00:00Z' }],
  categories: [
    { id: id(41), group_id: G, name: 'Food', sort: 10, created_by_email: E },
    { id: id(42), group_id: G, name: 'Fuel', sort: 20, created_by_email: F }],
});

let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };

async function session(browser, who) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.route('**/@supabase/supabase-js@*/**', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.addInitScript(([db, me, g]) => { window.__db = db; window.__me = me; try { localStorage.setItem('tripsplit:askedDetails:' + g, '1'); } catch {} }, [seed(), who, G]);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE);
  try { await p.waitForSelector('[data-action="go"][data-screen="ledger"]', { timeout: 8000 }); }
  catch (e) { console.log('STUCK ON:', (await p.locator('#app').innerText()).slice(0, 600), errors); throw e; }
  const go = async (screen) => { await p.click(`[data-action="go"][data-screen="${screen}"] >> nth=0`); await p.waitForTimeout(250); };
  const openTrip = async (tid) => { await go('trips'); await p.click(`[data-action="selectTrip"][data-id="${tid}"]`); await p.waitForTimeout(250); };
  const flash = async () => (await p.locator('.flash, .toast, [role="status"]').allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
  const rowButtons = async (desc) => {
    const card = p.locator('.card.entry', { hasText: desc });
    await card.locator('.entry-head').click(); await p.waitForTimeout(150);
    const out = { edit: await card.locator('[data-action="editExpense"]').count(), del: await card.locator('[data-action="del"]').count() };
    await card.locator('.entry-head').click(); await p.waitForTimeout(100);
    return out;
  };
  return { ctx, p, errors, go, openTrip, flash, rowButtons, db: () => p.evaluate(() => window.__db), calls: () => p.evaluate(() => window.__calls) };
}

(async () => {
  const browser = await chromium.launch();

  // ===================== Frank, a User =====================
  const u = await session(browser, F);
  const { p } = u;
  await u.openTrip(T1);
  await u.go('ledger');
  let b = await u.rowButtons('Harbor dinner');
  check("User: no Edit/Delete on Eric's expense", b.edit === 0 && b.del === 0, JSON.stringify(b));
  b = await u.rowButtons('Airport taxi');
  check('User: Edit and Delete on own expense', b.edit === 1 && b.del === 1, JSON.stringify(b));

  await u.go('trips');
  const editLink = async (tid) => p.locator(`[data-action="editTrip"][data-id="${tid}"]`).count();
  check("User: no Edit on Eric's trip", (await editLink(T1)) === 0);
  check('User: Edit on own trips', (await editLink(T2)) === 1 && (await editLink(T3)) === 1);

  await p.click(`[data-action="editTrip"][data-id="${T2}"]`); await p.waitForTimeout(250);
  check('User: own trip holding Eric\'s expense can now be deleted (his expense would move)', (await p.locator('[data-action="deleteTrip"]').count()) === 1);
  await u.go('trips');
  await p.click(`[data-action="editTrip"][data-id="${T3}"]`); await p.waitForTimeout(250);
  check('User: own solo trip has a Delete button', (await p.locator('[data-action="deleteTrip"]').count()) === 1);
  await p.click('[data-action="deleteTrip"]'); await p.waitForTimeout(500);
  let db = await u.db();
  check('User: deleting own solo trip works', !db.trips.some((t) => t.id === T3) && !db.entries.some((e) => e.trip_id === T3));

  await u.go('categories');
  const catRow = (name) => p.locator('.cat-row', { hasText: name });
  check("User: no Rename/Delete on Eric's category", (await catRow('Food').locator('[data-action="editCat"], [data-action="deleteCat"]').count()) === 0);
  check('User: Rename and Delete on own category', (await catRow('Fuel').locator('[data-action="editCat"]').count()) === 1 && (await catRow('Fuel').locator('[data-action="deleteCat"]').count()) === 1);
  check('User: no reorder arrows', (await p.locator('[data-action="moveCat"]').count()) === 0);
  await catRow('Fuel').locator('[data-action="editCat"]').click();
  await p.fill('[data-catedit]', 'Diesel'); await p.click('[data-action="saveCatName"]'); await p.waitForTimeout(400);
  db = await u.db();
  check('User: rename own category relabels the expenses using it', db.categories.some((c) => c.name === 'Diesel') && db.entries.find((e) => e.id === id(32)).category === 'Diesel');
  await p.fill('[data-newcat]', 'Marina fees'); await p.click('[data-action="addCat"]'); await p.waitForTimeout(400);
  check('User: new category can be renamed straight away', (await catRow('Marina fees').locator('[data-action="editCat"]').count()) === 1);

  // Log an expense on Eric's trip, adding Paul, who isn't on the trip yet.
  await u.openTrip(T1);
  await p.click('[data-action="go"][data-screen="add"], [data-action="newExpense"] >> nth=0').catch(() => {});
  if (!(await p.locator('[data-field="amt"]').count())) await p.click('[data-action="newExpense"] >> nth=0');
  await p.waitForSelector('[data-field="amt"]');
  await p.click('[data-action="openPicker"][data-for="share"]'); await p.waitForTimeout(200);
  await p.click(`[data-action="pickPerson"][data-id="${PP}"]`); await p.waitForTimeout(400);
  await p.fill('[data-field="amt"]', '90'); await p.fill('[data-field="desc"]', 'Gelato for all');
  await p.click('#save-btn'); await p.waitForTimeout(600);
  db = await u.db();
  const gel = db.entries.find((e) => e.description === 'Gelato for all');
  const t1 = db.trips.find((t) => t.id === T1);
  check("User: expense on Eric's trip saved, recorded as Frank's", !!gel && gel.created_by_email === F && !!gel.shares[PP]);
  check("User: Paul appended to Eric's trip through add_to_trip, trip otherwise untouched", t1.member_ids.includes(PP) && t1.name === 'Sardinia' && (await u.calls()).includes('rpc add_to_trip'));
  await u.go('ledger');
  b = await u.rowButtons('Gelato for all');
  check('User: can edit the expense they just added', b.edit === 1 && b.del === 1, JSON.stringify(b));

  // A stale screen: if the button were still there, the database refusal must show and undo.
  await p.evaluate(() => { window.__me = window.__me; });
  const before = (await u.db()).entries.length;
  await p.evaluate((eid) => { const b = document.createElement('button'); b.dataset.action = 'del'; b.dataset.id = eid; b.id = 'sneaky'; document.querySelector('#app main, #app').appendChild(b); }, id(31));
  await p.click('#sneaky'); await p.waitForTimeout(400);
  check("User: forced delete of Eric's expense refused with a message, nothing removed", (await u.db()).entries.length === before && /only change what you added/i.test(await p.locator('body').innerText()));

  await u.go('ledger');
  await p.locator('.card.entry', { hasText: 'Airport taxi' }).locator('.entry-head').click();
  await p.locator('.card.entry', { hasText: 'Airport taxi' }).locator('[data-action="del"]').click(); await p.waitForTimeout(500);
  check('User: delete own expense works', !(await u.db()).entries.some((e) => e.id === id(32)));
  check('User: no page errors', u.errors.length === 0, u.errors.join(' | '));
  await u.ctx.close();

  // ===================== Eric, an Administrator =====================
  const a = await session(browser, E);
  await a.openTrip(T1);
  await a.go('ledger');
  b = await a.rowButtons('Airport taxi');
  check("Admin: Edit and Delete on Frank's expense", b.edit === 1 && b.del === 1, JSON.stringify(b));
  await a.go('trips');
  check("Admin: Edit on Frank's trip", (await a.p.locator(`[data-action="editTrip"][data-id="${T2}"]`).count()) === 1);
  await a.p.click(`[data-action="editTrip"][data-id="${T2}"]`); await a.p.waitForTimeout(250);
  check("Admin: Delete on Frank's trip holding others' expenses", (await a.p.locator('[data-action="deleteTrip"]').count()) === 1);
  await a.go('trips');
  await a.go('categories');
  check('Admin: reorder arrows and Rename on every category', (await a.p.locator('[data-action="moveCat"]').count()) === 4 && (await a.p.locator('[data-action="editCat"]').count()) === 2);
  await a.p.locator('.cat-row', { hasText: 'Fuel' }).locator('[data-action="editCat"]').click();
  await a.p.fill('[data-catedit]', 'Fuel & diesel'); await a.p.click('[data-action="saveCatName"]'); await a.p.waitForTimeout(400);
  const cat = (await a.db()).categories.find((c) => c.name === 'Fuel & diesel');
  check("Admin: rename Frank's category, still recorded as Frank's", !!cat && cat.created_by_email === F);
  check('Admin: no page errors', a.errors.length === 0, a.errors.join(' | '));
  await a.ctx.close();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
