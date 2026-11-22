// The Add expense / Edit expense screen.
import { expect } from '@playwright/test';

export const expenseForm = (page) => {
  const chipFor = (action, name) => page.locator(`#main [data-action="${action}"]`, { hasText: name });
  return {
    amount: page.locator('#amt-input'),
    description: page.locator('[data-field="desc"]'),
    date: page.locator('[data-field="date"]'),
    status: page.locator('#add-status'),
    saveButton: page.locator('#save-btn'),

    // Fill what's given; anything left out keeps the form's default.
    async fill({ amount, description, date, category, payer } = {}) {
      if (amount !== undefined) await this.amount.fill(String(amount));
      if (description !== undefined) await this.description.fill(description);
      if (date !== undefined) await this.date.fill(date);
      if (category) await this.category(category);
      if (payer) await this.payer(payer);
    },
    exactAmount: (name) => page.locator(`#main [data-field="custom"][aria-label="Amount for ${name}"]`),
    // Pick the currency the expense was paid in (from the trip's list).
    async currency(code) {
      await page.locator('#main [data-action="toggleCur"]').click();
      await page.locator(`#main [data-action="pickCur"][data-c="${code}"]`).click();
      await expect(page.locator('#main [data-action="toggleCur"]')).toHaveText(code);
    },
    category: (name) => chipFor('cat', name).click(),
    payer: (name) => chipFor('payer', name).click(),
    payerChip: (name) => chipFor('payer', name),
    // Tap a person under "Who shares this cost?" (adds or removes them).
    toggleSharer: (name) => chipFor('inc', name).click(),
    sharerChip: (name) => chipFor('inc', name),
    // Split method: 'equal', 'people', 'cabins', 'exact'.
    mode: (m) => page.locator(`#main [data-action="mode"][data-mode="${m}"]`).click(),
    async save() {
      await expect(this.saveButton).toBeEnabled();
      await this.saveButton.click();
    },
    // "+ Add person" under Who paid? ('payer') or Who shares? ('share'), then a new name.
    async addNewPerson(forWhat, name) {
      await page.locator(`#main [data-action="openPicker"][data-for="${forWhat}"]`).click();
      await page.locator('[data-np="name"]').fill(name);
      await page.locator('[data-action="createPerson"]').click();
    },
  };
};
