// Browser test: inactive trips and trip deletion, as a User and as an Administrator.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const MOCK = fs.readFileSync(path.join(__dirname, 'stand-in-supabase.mjs'), 'utf8');
const BASE = process.env.TRIPSPLIT_BASE || 'http://localhost:8766/';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = id(1), PE = id(11), PF = id(12), PP = id(13), T1 = id(21), T2 = id(22), T3 = id(23);
const E = 'eric@ericdejager.com', F = 'frank@example.com';
const trip = (tid, name, by, members, extra = {}) => ({ id: tid, group_id: G, name, currency: 'USD', currencies: ['USD'], member_ids: members, weights: {}, default_split: 'equal', created_by_email: by, inactive_at: null, inactive_by: null, default_for_email: null, created_at: '2026-11-0' + (tid.slice(-1)) + 'T00:00:00Z', ...extra });
const entry = (n, tid, desc, payer, by, shares, kind = 'expense') => ({ id: id(n), group_id: G, trip_id: tid, kind, description: desc, category: 'Food', spent_on: '2026-11-1' + (n % 10), amount_cents: Object.values(shares).reduce((a, b) => a + b, 0), payer, shares, split_mode: 'equal', created_by_email: by, created_at: `2026-11-1${n % 10}T10:00:00Z`, moved_from: null });
const seed = () => ({
  groups: [{ id: G, name: 'Sailing test', created_at: '2026-11-01T00:00:00Z' }],
  group_members: [{ group_id: G, email: E, role: 'admin', added_at: '2026-11-01' }, { group_id: G, email: F, role: 'user', added_at: '2026-11-02' }],
  invitations: [],
  parties: [
    { id: PE, group_id: G, name: 'Eric de Jager', email: E, color: 0, payment: {} },
    { id: PF, group_id: G, name: 'Frank Forte', email: F, color: 1, payment: {} },
    { id: PP, group_id: G, name: 'Paul Martin', email: null, color: 2, payment: {} }],
  trips: [trip(T1, 'Sardinia', E, [PE, PF]), trip(T2, 'Frank shared trip', F, [PF, PE]), trip(T3, 'Frank solo trip', F, [PF])],
  entries: [
    entry(31, T1, 'Harbor dinner', PE, E, { [PE]: 5000, [PF]: 5000 }),
    entry(32, T1, 'Airport taxi', PF, F, { [PE]: 3000, [PF]: 3000 }),
    entry(33, T2, 'Groceries', PE, E, { [PE]: 2000, [PF]: 2000 }),
    entry(35, T2, 'Boat snacks', PF, F, { [PE]: 1000, [PF]: 1000 }),
    entry(34, T3, 'Fuel stop', PF, F, { [PF]: 3000 })],
  categories: [{ id: id(41), group_id: G, name: 'Food', sort: 10, created_by_email: E }],
});

let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };

async function session(browser, who) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.route('**/@supabase/supabase-js@*/**', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.addInitScript(([db, me, g]) => { window.__db = db; window.__me = me; try { localStorage.setItem('tripsplit:askedDetails:' + g, '1'); } catch {} }, [seed(), who, G]);
  const p = await ctx.newPage();
  const errors = [], dialogs = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.goto(BASE);
  await p.waitForSelector('[data-action="go"][data-screen="ledger"]', { timeout: 15000 });
  const go = async (screen) => { await p.click(`[data-action="go"][data-screen="${screen}"] >> nth=0`); await p.waitForTimeout(250); };
  const openTrip = async (tid) => { await go('trips'); await p.click(`[data-action="selectTrip"][data-id="${tid}"]`); await p.waitForTimeout(250); };
  const text = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  return { ctx, p, errors, dialogs, go, openTrip, text, db: () => p.evaluate(() => window.__db) };
}

(async () => {
  const browser = await chromium.launch();

  // ===================== Frank, a User =====================
  const u = await session(browser, F);
  const { p } = u;
  await u.go('trips');
  await p.click(`[data-action="editTrip"][data-id="${T3}"]`); await p.waitForTimeout(250);
  check('Owner sees Mark trip inactive and Delete trip', (await p.locator('[data-action="setTripActive"][data-active="0"]').count()) === 1 && (await p.locator('[data-action="deleteTrip"]').count()) === 1);
  await p.click('[data-action="setTripActive"]'); await p.waitForTimeout(400);
  let db = await u.db();
  check('Mark inactive: saved, with who did it', !!db.trips.find((t) => t.id === T3).inactive_at && db.trips.find((t) => t.id === T3).inactive_by === F);
  check('Mark inactive: confirmation asked first', /Mark “Frank solo trip” inactive\?/.test(u.dialogs.at(-1) || ''), u.dialogs.at(-1));
  const allT3 = await p.locator(`[data-action="selectTrip"][data-id="${T3}"]`).count();
  const inSection = await p.locator(`details.inactive-trips [data-action="selectTrip"][data-id="${T3}"]`).count();
  check('Inactive trip leaves the main list', allT3 === 1 && inSection === 1, `${allT3} ${inSection}`);
  check('Inactive trips section shows 1', /Inactive trips \(1\)/.test(await u.text()));
  await p.click('details.inactive-trips > summary'); await p.waitForTimeout(250);
  check('Section opens, trip carries an Inactive badge', (await p.locator('details.inactive-trips[open] .badge', { hasText: 'Inactive' }).count()) === 1);

  await p.click(`details.inactive-trips [data-action="selectTrip"][data-id="${T3}"]`); await p.waitForTimeout(300);
  await u.go('ledger');
  check('Inactive trip shows the banner', /This trip is inactive/.test(await u.text()));
  await p.locator('.card.entry', { hasText: 'Fuel stop' }).locator('.entry-head').click(); await p.waitForTimeout(150);
  check('Inactive trip: no Edit/Delete even on your own expense', (await p.locator('.card.entry', { hasText: 'Fuel stop' }).locator('[data-action="editExpense"], [data-action="del"]').count()) === 0);
  await p.click('[data-action="newExpense"]'); await p.waitForTimeout(300);
  check('Inactive trip: Add is refused with a message', /This trip is inactive\. Make it active again to change it\./.test(await u.text()) && (await p.locator('[data-field="amt"]').count()) === 0);
  await u.go('trips');
  if (!(await p.locator('details.inactive-trips[open]').count())) await p.click('details.inactive-trips > summary');
  await p.click(`[data-action="editTrip"][data-id="${T3}"]`); await p.waitForTimeout(250);
  await p.click('[data-action="setTripActive"][data-active="1"]'); await p.waitForTimeout(400);
  db = await u.db();
  check('Make active again: saved, back in the main list', !db.trips.find((t) => t.id === T3).inactive_at && !(await p.locator('details.inactive-trips').count()));

  // Delete Frank's shared trip: his own expense goes, Eric's moves to Eric's default trip.
  await u.go('trips');
  await p.click(`[data-action="editTrip"][data-id="${T2}"]`); await p.waitForTimeout(250);
  check('Delete note explains other people’s entries move', /other people added move to a default trip each of them owns/.test(await u.text()));
  await p.click('[data-action="deleteTrip"]'); await p.waitForTimeout(700);
  const conf = u.dialogs.at(-1) || '';
  check('Delete confirmation names what happens', /Your 1 entry will be deleted\./.test(conf) && /Eric de Jager’s 1 entry will move to a trip of their own\./.test(conf), conf.replace(/\n/g, ' | '));
  db = await u.db();
  const dflt = db.trips.find((t) => t.default_for_email === E);
  const groc = db.entries.find((e) => e.id === id(33));
  check('Trip and Frank’s own expense deleted', !db.trips.some((t) => t.id === T2) && !db.entries.some((e) => e.id === id(35)));
  check('Eric’s expense moved, unchanged, to Eric’s default trip', !!dflt && groc.trip_id === dflt.id && groc.created_by_email === E && groc.amount_cents === 4000 && dflt.name === "Eric's expenses");
  check('Summary message after delete', /Frank shared trip deleted\. Moved 1 entry of Eric’s to “Eric's expenses”\./.test(await u.text()));
  await u.go('trips');
  const card = p.locator('.trip-card', { hasText: "Eric's expenses" });
  check('Default trip listed with a badge, no Edit for Frank', (await card.locator('.badge', { hasText: 'Default trip' }).count()) === 1 && (await card.locator('[data-action="editTrip"]').count()) === 0);
  await card.locator('[data-action="selectTrip"]').click(); await p.waitForTimeout(250);
  await u.go('ledger');
  await p.locator('.card.entry', { hasText: 'Groceries' }).locator('.entry-head').click(); await p.waitForTimeout(150);
  check('Ledger shows where the expense came from', /Moved from Frank shared trip, deleted by Frank Forte on /.test(await u.text()));
  check('User: no page errors', u.errors.length === 0, u.errors.join(' | '));
  await u.ctx.close();

  // ===================== Eric, an Administrator =====================
  const a = await session(browser, E);
  await a.go('trips');
  await a.p.click(`[data-action="editTrip"][data-id="${T2}"]`); await a.p.waitForTimeout(250);
  check('Admin: status and delete on Frank’s trip', (await a.p.locator('[data-action="setTripActive"]').count()) === 1 && (await a.p.locator('[data-action="deleteTrip"]').count()) === 1);
  await a.p.click('[data-action="deleteTrip"]'); await a.p.waitForTimeout(700);
  const db2 = await a.db();
  const fd = db2.trips.find((t) => t.default_for_email === F);
  check('Admin delete: Frank’s expense moves to Frank’s default trip, Eric’s own deleted',
    !!fd && db2.entries.find((e) => e.id === id(35)).trip_id === fd.id && !db2.entries.some((e) => e.id === id(33)), JSON.stringify(a.dialogs.at(-1)));
  check('Admin: no page errors', a.errors.length === 0, a.errors.join(' | '));
  await a.ctx.close();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
