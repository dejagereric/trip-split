// Moving around the app: the trip tabs, the Trips list, and the toast message.
import { expect } from '@playwright/test';

export const app = (page) => ({
  // Trip tabs: 'balances', 'add', 'ledger', 'settle'.
  async tab(screen) {
    if (screen === 'add') await page.locator('nav.tabs [data-action="newExpense"]').click();
    else await page.locator(`nav.tabs [data-action="go"][data-screen="${screen}"]`).click();
    await expect(page.locator(`#main[data-screen="${screen}"]`)).toBeVisible();
  },
  async openTrip(tripId) {
    await page.locator('[data-action="go"][data-screen="trips"]').first().click();
    await page.locator(`[data-action="selectTrip"][data-id="${tripId}"]`).click();
    await expect(page.locator('#main[data-screen="balances"]')).toBeVisible();
  },
  screen: () => page.locator('#main').getAttribute('data-screen'),
  toast: () => page.locator('.toast'),
});
