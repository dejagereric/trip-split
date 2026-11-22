// P1: entering, editing and deleting expenses. Expected amounts are written out by hand;
// the starting numbers for "Regression USD" are in seed-data.mjs (EXPECT.usd).
import { test, expect } from './fixtures.mjs';
import { app } from './pages/app.mjs';
import { expenseForm } from './pages/expenseForm.mjs';
import { ledger } from './pages/ledger.mjs';
import { balances } from './pages/balances.mjs';
import { TRIPS, USERS } from './seed-data.mjs';

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

});

// How amounts are typed: USD "1,234.50" (comma between thousands, period before the cents),
// EUR "1.234,50" (the other way round). Every other currency types like USD.
test.describe('Typing amounts @p1 @expense @currency', () => {
  const save = async (page, amount, description) => {
    const form = expenseForm(page);
    await app(page).tab('add');
    await form.fill({ amount, description, date: '2026-10-17' });
    await form.save();
    await app(page).tab('ledger');
    return ledger(page).card(description);
  };

  test('USD: "1,234.50" is one thousand two hundred thirty-four dollars fifty', async ({ as }) => {
    const page = await as('admin');
    await expect(await save(page, '1,234.50', 'Charter deposit')).toContainText('$1,234.50');
  });

  for (const bad of ['1,5', '12,50']) {
    test(`USD: "${bad}" isn't guessed at; the form says how to type it`, async ({ as }) => {
      const page = await as('admin');
      const form = expenseForm(page);
      await app(page).tab('add');
      await form.fill({ amount: bad, description: 'Comma test' });
      await expect(form.status).toHaveText('In USD, type amounts like 1,234.50 (period before the cents).');
      await expect(form.saveButton).toBeDisabled();
    });
  }

  test('EUR: "12,50" and "1.234,50" use a comma before the cents', async ({ as }) => {
    const page = await as('admin', { trip: TRIPS.eur });
    await expect(await save(page, '12,50', 'Espresso')).toContainText('€12.50');
    await expect(await save(page, '1.234,50', 'Boat hire')).toContainText('€1,234.50');
  });

  test('EUR: "12.50" isn\'t guessed at; the form says how to type it', async ({ as }) => {
    const page = await as('admin', { trip: TRIPS.eur });
    const form = expenseForm(page);
    await app(page).tab('add');
    await expect(form.amount).toHaveAttribute('placeholder', '0,00');
    await form.fill({ amount: '12.50', description: 'Period test' });
    await expect(form.status).toHaveText('In EUR, type amounts like 1.234,50 (comma before the cents).');
    await expect(form.saveButton).toBeDisabled();
  });

  test('EUR: editing fills the amount in with a comma, and Exact shares too', async ({ as }) => {
    const page = await as('admin', { trip: TRIPS.eur });
    const form = expenseForm(page);
    await app(page).tab('ledger');
    await ledger(page).edit('Museum tickets');
    await expect(form.amount).toHaveValue('50,00');
    await form.mode('exact');
    await expect(form.exactAmount(USERS.admin.name)).toHaveValue('25,00');
    await expect(form.exactAmount(USERS.user.name)).toHaveValue('25,00');
    await form.exactAmount(USERS.admin.name).fill('30,00');
    await form.exactAmount(USERS.user.name).fill('20,00');
    await form.save();
    await expect(ledger(page).card('Museum tickets')).toContainText('€50.00');
    await expect(ledger(page).card('Museum tickets')).toContainText('(custom)');
  });

  test('switching an expense from USD to EUR rewrites what was typed the EUR way', async ({ as }) => {
    const page = await as('admin');
    const form = expenseForm(page);
    await app(page).tab('add');
    await form.fill({ amount: '1,234.50', description: 'Marina in Croatia', date: '2026-10-15' });
    await form.currency('EUR');
    await expect(form.amount).toHaveValue('1234,50');
    await expect(page.locator('#fx-rate')).toHaveValue('1.1'); // the stand-in's rate
    await form.save();
    await app(page).tab('ledger');
    const card = ledger(page).card('Marina in Croatia');
    await expect(card).toContainText('€1,234.50');
    await expect(card).toContainText('$1,357.95'); // 1,234.50 × 1.1
  });
});

// Saving while offline: the form stays filled until the connection is back, then it saves by itself.
test.describe('Saving without a connection @p1 @expense', () => {
  const OFFLINE_MSG = 'No connection. Your expense is kept here and saves by itself when you’re back online.';
  const waiting = (page) => page.locator('#main .pending-save');

  test('the form stays filled, and the expense saves itself once back online', async ({ as, goOffline, goOnline }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page), bal = balances(page);
    await nav.tab('add');
    await form.fill({ amount: '25', description: 'Lost in the tunnel', date: '2026-10-17', category: 'Transport' });
    await goOffline(page);
    await form.save();

    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await expect(page.locator('#main')).toHaveAttribute('data-screen', 'add');
    await expect(form.amount).toHaveValue('25');
    await expect(form.description).toHaveValue('Lost in the tunnel');
    await expect(form.date).toHaveValue('2026-10-17');
    await expect(page.locator('#main [data-action="cat"][aria-pressed="true"]')).toHaveText('Transport');
    await expect(waiting(page)).toContainText('Waiting for a connection');
    // Not counted anywhere until it's saved.
    await nav.tab('ledger');
    await expect(led.card('Lost in the tunnel')).toHaveCount(0);
    await nav.tab('balances');
    await expect(bal.total).toHaveText('$235.00');
    // Going back to Add still shows it.
    await nav.tab('add');
    await expect(form.description).toHaveValue('Lost in the tunnel');

    await goOnline(page);
    await expect(nav.toast()).toHaveText('Saved “Lost in the tunnel” now that you’re back online');
    await expect(page.locator('#main')).toHaveAttribute('data-screen', 'balances');
    await expect(bal.total).toHaveText('$260.00');
    await nav.tab('ledger');
    await expect(led.card('Lost in the tunnel')).toHaveCount(1);
    await nav.tab('add');
    await expect(form.description).toHaveValue('');
    await expect(waiting(page)).toHaveCount(0);
  });

  test('tapping Save again while offline never makes a second copy', async ({ as, goOffline, goOnline }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '12', description: 'Parking', date: '2026-10-17' });
    await goOffline(page);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await goOnline(page);
    await expect(nav.toast()).toHaveText(/back online/);
    await nav.tab('ledger');
    await nav.refreshData();
    await expect(led.card('Parking')).toHaveCount(1);
    await expect(led.cards).toHaveCount(4);
  });

  test('a save whose reply was lost doesn\'t make a second copy when it\'s retried', async ({ as, loseNextReply }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '14', description: 'Toll road', date: '2026-10-17' });
    await loseNextReply(page);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await form.save(); // tapped again by hand: the same expense, not a new one
    await expect(nav.toast()).toHaveText('Added “Toll road” · $14.00');
    await nav.tab('ledger');
    await nav.refreshData(); // what the database holds, not just this phone's copy
    await expect(led.card('Toll road')).toHaveCount(1);
    await expect(led.cards).toHaveCount(4);
  });

  test('a change made while waiting is kept, and saving it updates the same expense', async ({ as, goOffline, goOnline }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '30', description: 'Ferry', date: '2026-10-17' });
    await goOffline(page);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await form.fill({ amount: '35' }); // typed after the failed save, not saved yet
    await goOnline(page);
    await expect(nav.toast()).toHaveText(/back online/);
    await expect(form.amount).toHaveValue('35');          // what they typed is still there
    await expect(form.saveButton).toHaveText('Save changes'); // ...and now edits the saved expense
    await form.save();
    await expect(nav.toast()).toHaveText('Changes saved');
    await expect(led.card('Ferry')).toHaveCount(1);
    await expect(led.card('Ferry')).toContainText('$35.00');
  });

  test('editing an expense offline keeps the edit until it can be saved', async ({ as, goOffline, goOnline }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('ledger');
    await led.edit('Harbor dinner');
    await form.fill({ amount: '95' });
    await goOffline(page);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    await expect(form.saveButton).toHaveText('Save changes');
    await expect(form.amount).toHaveValue('95');
    await goOnline(page);
    await expect(nav.toast()).toHaveText(/back online/);
    await expect(page.locator('#main')).toHaveAttribute('data-screen', 'ledger');
    await expect(led.card('Harbor dinner')).toContainText('$95.00');
  });

  test('a waiting expense survives closing the app, and saves when it opens with a connection', async ({ as, goOffline }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '18', description: 'Bus tickets', date: '2026-10-17' });
    await goOffline(page);
    await form.save();
    await expect(nav.toast()).toHaveText(OFFLINE_MSG);
    // The phone reconnects only as the app is reopened: keep the stand-in refusing until the reload.
    await page.context().setOffline(false);
    await expect(waiting(page)).toBeVisible();
    await page.reload();
    await expect(nav.toast()).toHaveText('Saved “Bus tickets” now that you’re back online');
    await nav.tab('ledger');
    await expect(led.card('Bus tickets')).toHaveCount(1);
  });

  test('a save refused for another reason keeps the form filled and isn\'t retried', async ({ as, refuseNextSave }) => {
    const page = await as('admin');
    const nav = app(page), form = expenseForm(page), led = ledger(page);
    await nav.tab('add');
    await form.fill({ amount: '40', description: 'Refused one', date: '2026-10-17' });
    await refuseNextSave(page); // a refusal from the database, not a lost connection
    await form.save();
    await expect(nav.toast()).toHaveText('You don’t have permission to do that. Ask an Administrator.');
    await expect(form.description).toHaveValue('Refused one');
    await expect(waiting(page)).toHaveCount(0);
    await nav.tab('ledger');
    await expect(led.card('Refused one')).toHaveCount(0);
  });
});
