// Shared Playwright fixtures, so every spec runs unchanged in both modes.
//   hermetic: the app talks to tests/browser/stand-in-supabase.mjs, seeded from seed-data.mjs
//   staging:  the app talks to the staging Supabase project (sign-in arrives in step 5 of the plan)
import { test as base, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import { seed, USERS, TRIPS } from './seed-data.mjs';

const STAND_IN = fs.readFileSync(new URL('../browser/stand-in-supabase.mjs', import.meta.url), 'utf8');

export const test = base.extend({
  // Set per project in playwright.config.mjs.
  mode: ['hermetic', { option: true }],

  // as('admin' | 'user' | 'outsider', { trip }) → a page signed in as that person, open on that trip
  // (Regression USD unless given; pass trip: null to land on the Trips list).
  // Each call is its own browser context. Page errors fail the test.
  as: async ({ browser, mode, baseURL }, use) => {
    const opened = [];
    await use(async (role, { trip = role === 'outsider' ? null : TRIPS.usd } = {}) => {
      const user = USERS[role];
      if (!user) throw new Error(`Unknown role "${role}"`);
      if (mode !== 'hermetic') throw new Error('Staging sign-in is not set up yet (step 5 of docs/regression-test-plan.md).');
      const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL });
      await ctx.route('**/@supabase/supabase-js@*/**', (r) => r.fulfill({ contentType: 'text/javascript', body: STAND_IN }));
      await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
      await ctx.addInitScript(([db, email, g, t]) => {
        window.__db = db;
        window.__me = email;
        try {
          localStorage.setItem('tripsplit:askedDetails:' + g, '1');
          localStorage.setItem('tripsplit:activeGroup', g);
          if (t) localStorage.setItem('tripsplit:activeTrip:' + g, t);
        } catch { /* storage blocked: the app still works */ }
      }, [seed(), user.email, user.group, trip]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept()); // "Delete … for everyone?" and similar confirmations
      opened.push({ ctx, errors, role });
      await page.goto('./');
      await expect(page.locator('#main')).toBeVisible();
      if (trip) await expect(page.locator('nav.tabs')).toBeVisible();
      return page;
    });
    for (const { ctx, errors, role } of opened) {
      await ctx.close();
      expect(errors, `page errors while signed in as ${role}`).toEqual([]);
    }
  },

  // failNextSave(page): the next write to the database fails, as it would offline.
  failNextSave: async ({ mode }, use) => {
    await use(async (page) => {
      if (mode === 'hermetic') { await page.evaluate(() => { window.__failNext = true; }); return; }
      let done = false;
      await page.route('**/rest/v1/**', (r) => {
        if (done || r.request().method() === 'GET') return r.continue();
        done = true;
        return r.abort('internetdisconnected');
      });
    });
  },
});

export { expect };
