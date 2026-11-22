// The Ledger screen: entry cards, opening one, Edit and Delete.
import { expect } from '@playwright/test';

export const ledger = (page) => {
  const card = (title) => page.locator('#ledger-list .card.entry', { has: page.locator('.entry-head .strong', { hasText: title }) });
  return {
    cards: page.locator('#ledger-list .card.entry'),
    card,
    // Titles in the order shown (newest first).
    titles: () => page.locator('#ledger-list .card.entry .entry-head > .grow > .strong').allInnerTexts(),
    async open(title) {
      const c = card(title);
      if ((await c.locator('.entry-head').getAttribute('aria-expanded')) !== 'true') await c.locator('.entry-head').click();
      await expect(c.locator('.entry-body')).toBeVisible();
      return c;
    },
    async edit(title) { await (await this.open(title)).locator('[data-action="editExpense"]').click(); },
    async remove(title) { await (await this.open(title)).locator('[data-action="del"]').click(); },
  };
};
