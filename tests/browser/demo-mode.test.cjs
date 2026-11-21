// Browser test: on-phone demo mode (no Supabase). Everything stays editable; inactive trips and
// delete work locally.
const { chromium, devices } = require('playwright');
const BASE = process.env.TRIPSPLIT_BASE || 'http://localhost:8766/';
let failures = 0;
const check = (l, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${x ? ' — ' + x : ''}`); if (!c) failures++; };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const CONFIG={defaultCurrency:'USD',supabaseUrl:'',supabaseAnonKey:'',googleClientId:''};" }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); const errs = [], dialogs = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  const go = async (s) => { await p.click(`[data-action="go"][data-screen="${s}"] >> nth=0`); await p.waitForTimeout(300); };
  await p.goto(BASE); await p.waitForTimeout(800);
  await p.click('[data-action="loadSample"]'); await p.waitForTimeout(800);
  await go('ledger');
  await p.locator('.card.entry .entry-head').nth(1).click(); await p.waitForTimeout(200);
  check('Expenses keep Edit and Delete', (await p.locator('[data-action="editExpense"]').count()) >= 1 && (await p.locator('[data-action="del"]').count()) >= 1);
  await go('trips');
  const trips = await p.locator('.trip-card').count();
  check('Every trip has Edit', (await p.locator('[data-action="editTrip"]').count()) === trips);
  await go('categories');
  check('Categories can be reordered', (await p.locator('[data-action="moveCat"]').count()) > 0);
  await go('trips');
  await p.click('[data-action="editTrip"] >> nth=0'); await p.waitForTimeout(300);
  await p.click('[data-action="setTripActive"]'); await p.waitForTimeout(400);
  check('Mark inactive moves the trip to the Inactive section', /Inactive trips \(1\)/.test(await p.locator('body').innerText()) && (await p.locator('.trip-card').count()) === trips);
  await p.click('[data-action="editTrip"] >> nth=0'); await p.waitForTimeout(300);
  await p.click('[data-action="deleteTrip"]'); await p.waitForTimeout(600);
  check('Delete removes a trip, with a plain confirmation', (await p.locator('.trip-card').count()) === trips - 1 && /for everyone\? This can’t be undone\./.test(dialogs.at(-1) || ''), dialogs.at(-1));
  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close(); console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures ? 1 : 0);
})();
