// P1: entering, editing and deleting expenses. Expected amounts are written out by hand;
// the starting numbers for "Regression USD" are in seed-data.mjs (EXPECT.usd).
import { test, expect } from './fixtures.mjs';
import { app } from './pages/app.mjs';
import { expenseForm } from './pages/expenseForm.mjs';
import { ledger } from './pages/ledger.mjs';
import { balances } from './pages/balances.mjs';

test.describe('Expenses @p1 @expense', () => {
  test('adding an expense saves every field and shows it in the Ledger and Recent', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page), bal = balances(page);
    await expect(bal.total).toHaveText('$235.00');

    await nav.tab('add');
    await form.fill({ amount: '60', description: 'Boat fuel', date: '2026-10-17', category: 'Transport', payer: 'Uma' });
    await expect(form.status).toHaveText(/^Ready\./);
    await form.save();

    await expect(nav.toast()).toHaveText('Added “Boat fuel” · $60.00');
    await expect(page.locator('#main')).toHaveAttribute('data-screen', 'balances');
    await expect(bal.total).toHaveText('$295.00');
    await expect(bal.counts).toContainText('4 expenses');
    expect((await bal.recentTitles())[0]).toBe('Boat fuel');

    await nav.tab('ledger');
    expect((await led.titles())[0]).toBe('Boat fuel'); // Oct 17 is the newest date
    const card = led.card('Boat fuel');
    await expect(card).toContainText('Oct 17 · Transport');
    await expect(card).toContainText(/Paid by Uma[^·]*· split by everyone/);
    await expect(card).toContainText('$60.00');
    await led.open('Boat fuel');
    await expect(card).toContainText('Added by you');
  });

  test('an equal split that doesn\'t divide evenly gives the extra cent to the first people', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page);
    await nav.tab('add');
    await form.fill({ amount: '100', description: 'Fish market', date: '2026-10-17' });
    await form.save();
    await nav.tab('ledger');
    // $100.00 among Ada, Uma, Paul (trip order) → 33.34 / 33.33 / 33.33, on top of the seed's shares.
    const benefitted = async (name) => {
      await page.locator('#main [data-action="filter"]', { hasText: name }).click();
      return page.locator('#main .card.dark .grid2 > div').nth(1).locator('.mid').innerText();
    };
    expect(await benefitted('Ada')).toBe('$119.18');  // 85.84 + 33.34
    expect(await benefitted('Uma')).toBe('$119.16');  // 85.83 + 33.33
    expect(await benefitted('Paul')).toBe('$96.66');  // 63.33 + 33.33
  });

  test('editing an expense fills the form with what was saved and keeps the changes', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page), bal = balances(page);
    await nav.tab('ledger');
    await led.edit('Harbor dinner');

    await expect(form.amount).toHaveValue('90.00');
    await expect(form.description).toHaveValue('Harbor dinner');
    await expect(form.date).toHaveValue('2026-10-15');
    await expect(form.payerChip('Ada')).toHaveAttribute('aria-pressed', 'true');
    await expect(form.saveButton).toHaveText('Save changes');

    await form.fill({ amount: '120', description: 'Harbor dinner and wine' });
    await form.save();
    await expect(nav.toast()).toHaveText('Changes saved');
    await expect(page.locator('#main')).toHaveAttribute('data-screen', 'ledger');
    await expect(led.card('Harbor dinner and wine')).toContainText('$120.00');
    await expect(led.card('Harbor dinner')).toHaveCount(1); // the same entry, renamed, not a copy
    await expect(led.cards).toHaveCount(3);

    await nav.tab('balances');
    await expect(bal.total).toHaveText('$265.00');
  });

  test('deleting an expense removes it for everyone and from the totals', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), led = ledger(page), bal = balances(page);
    await nav.tab('ledger');
    await led.remove('Groceries');
    await expect(nav.toast()).toHaveText('Entry deleted');
    await expect(led.card('Groceries')).toHaveCount(0);
    await expect(led.cards).toHaveCount(2);
    await nav.tab('balances');
    await expect(bal.total).toHaveText('$135.00');
  });

  for (const bad of ['0', 'abc', '']) {
    test(`an amount of "${bad}" can't be saved`, async ({ as }) => {
      const page = await as('admin');
      const form = expenseForm(page);
      await app(page).tab('add');
      await form.fill({ amount: bad, description: 'Nothing' });
      await expect(form.status).toHaveText('Enter an amount.');
      await expect(form.saveButton).toBeDisabled();
    });
  }

  test('a minus sign is never saved as a negative amount', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '-5', description: 'Minus test', date: '2026-10-17' });
    await form.save();
    await nav.tab('ledger');
    await expect(led.card('Minus test')).toContainText('$5.00');
    await nav.tab('balances');
    await expect(balances(page).total).toHaveText('$240.00');
  });

  // Today "1,5" is read as 15.00, because the comma is dropped. Someone used to a decimal comma
  // meant 1.50. Decide the intended behavior, then remove .fixme.
  test.fixme('"1,5" is read as 1.50, not 15.00', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '1,5', description: 'Comma test', date: '2026-10-17' });
    await form.save();
    await nav.tab('ledger');
    await expect(led.card('Comma test')).toContainText('$1.50');
  });

  // Uma is second on the trip, so this also catches "first person on the trip" passing for "you".
  for (const [role, me] of [['admin', 'Ada'], ['user', 'Uma']]) {
    test(`you are the default payer and a sharer on a new expense (${me})`, async ({ as }) => {
      const page = await as(role);
      const form = expenseForm(page);
      await app(page).tab('add');
      await expect(form.payerChip(me)).toHaveAttribute('aria-pressed', 'true');
      await expect(form.payerChip(me)).toContainText('(you)');
      await expect(page.locator('#main [data-action="payer"][aria-pressed="true"]')).toHaveCount(1);
      for (const name of ['Ada', 'Uma', 'Paul']) await expect(form.sharerChip(name)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#main')).toContainText('Entering this for others? Tap your name to take yourself off.');
    });
  }

  test('taking yourself off the sharers splits the cost among the others', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.toggleSharer('Ada');
    await expect(form.sharerChip('Ada')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#main')).toContainText('You’re not sharing this one.');
    await form.fill({ amount: '30', description: 'Kids ice cream', date: '2026-10-17' });
    await expect(form.status).toContainText(/shared by Uma.*Paul/);
    await form.save();

    await nav.tab('ledger');
    const sub = led.card('Kids ice cream').locator('.entry-head > .grow > .small.muted').last();
    await expect(sub).toHaveText(/Paid by Ada[^·]*· split by Uma[^·]*Paul/);
    // Uma and Paul each benefitted $15.00 more; Ada's share is unchanged.
    await page.locator('#ledger-list').waitFor();
    await page.locator('#main [data-action="filter"]', { hasText: 'Ada' }).click();
    await expect(page.locator('#main .card.dark')).toContainText('$85.84'); // Ada benefitted: unchanged
    await page.locator('#main [data-action="filter"]', { hasText: 'Uma' }).click();
    await expect(page.locator('#main .card.dark')).toContainText('$100.83'); // 85.83 + 15.00
  });

  test('a new person added from "+ Add person" joins the expense and the trip', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page), bal = balances(page);
    await nav.tab('add');
    await form.addNewPerson('share', 'Rita Rowe');
    await expect(form.sharerChip('Rita')).toHaveAttribute('aria-pressed', 'true');
    await form.fill({ amount: '40', description: 'Sunset cruise', date: '2026-10-17' });
    await form.save();
    await expect(bal.counts).toContainText('4 people');

    await nav.tab('ledger');
    await expect(led.card('Sunset cruise')).toContainText('split by everyone');
    await page.locator('#main [data-action="filter"]', { hasText: 'Rita' }).click();
    await expect(page.locator('#main .card.dark')).toContainText('$10.00'); // $40 split 4 ways
  });

  test('Mark as paid records a payment entry in the Ledger', async ({ as }) => {
    const page = await as('admin');
    const nav = app(page), led = ledger(page);
    await nav.tab('settle');
    // Nets: Ada +4.16, Uma −40.83, Paul +36.67, so Uma makes both payments.
    await expect(page.locator('#main .transfer')).toHaveCount(2);
    const first = page.locator('#main .card:has(.transfer)').first();
    const amount = (await first.locator('.transfer .mid').innerText()).trim();
    expect(['$36.67', '$4.16']).toContain(amount);
    await first.locator('[data-action="record"]').click();
    await expect(nav.toast()).toHaveText(new RegExp(`^Recorded: Uma.* paid .* \\${amount}$`));
    await expect(page.locator('#main .transfer')).toHaveCount(1);

    await nav.tab('ledger');
    const payment = page.locator('#ledger-list .card.entry', { hasText: 'Payment between people' });
    await expect(payment).toHaveCount(1);
    await expect(payment).toContainText('Settle-up payment');
    await expect(payment).toContainText(amount);
  });

  test('a save that fails is rolled back and says why', async ({ as, failNextSave }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page), bal = balances(page);
    await nav.tab('add');
    await form.fill({ amount: '25', description: 'Lost in the tunnel', date: '2026-10-17' });
    await failNextSave(page);
    await form.save();
    await expect(nav.toast()).not.toHaveText(/^Added/);
    await expect(nav.toast()).toBeVisible();
    await expect(bal.total).toHaveText('$235.00');
    await nav.tab('ledger');
    await expect(led.card('Lost in the tunnel')).toHaveCount(0);
    await expect(led.cards).toHaveCount(3);
  });
});
