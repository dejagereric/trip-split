# Trip Split

A phone web app for tracking shared vacation costs. Keep as many trips as you like. Anyone can log an expense, choose who shares it, scan the receipt, and see everyone's running totals. At the end, it shows the fewest payments that settle everything.

It's for tracking and communication only: no bank accounts, cards or payments.

No App Store or Google Play listing needed. It's a website you add to your home screen.

## How it's organized

- **Trips** are the master record. Each expense belongs to exactly one trip and never shows up in another.
- **People** are shared across trips: name, phone, email. One person can be on many trips.
- **Adding someone to a trip takes no setup.** On *Add expense*, tap **+ Add person**. Pick someone you've traveled with, choose a phone contact, or type a new name. They join the trip's *frequent participants* immediately.
- **Added the wrong person?** Open the trip (**trip name ▾ → Edit**) and tap **Remove** next to them. Anyone already on an expense stays until that expense is edited or deleted, so balances never break.

## Screens

- **Trips / People** (tap the trip name at the top):
  - Trips: create, rename, set dates and currency, switch, delete.
  - People: add, edit or delete people. Each has a name, phone, email and color, and can be filled in from your contacts.
- **Balances**: each person's total spent, total shared spending, and who would pay whom if you squared up now.
- **Add / edit expense**: scan a receipt (fills in description, date and total), amount, date, category, who paid, who shares it, and an equal or exact-amount split.
- **Ledger**: every entry for the trip, filterable by person. Filtering shows that person's **Spent** and **Benefitted** totals. Tap an entry to view its receipt, edit it or delete it.
- **Settle up**: the payments due, with **Text** / **Email** buttons when a phone or email is on file. Also a Spent / Benefitted / Net breakdown, a summary to share in the group chat, and **Mark as paid**.

### Contacts

On phones that support the browser's Contact Picker (Chrome on Android), you'll see **Choose from contacts**. Your phone shows its own contact list and hands the app **only the one person you pick**. The app never reads or uploads your address book. Safari on iPhone doesn't offer this yet (it's an experimental setting), so there you type the name, phone and email.

## 1. Try it locally (demo mode)

With `supabaseUrl` blank in `js/config.js`, the app runs in **demo mode**: data stays in one browser and receipts are attached but not read automatically.

```bash
npx serve .          # or: python3 -m http.server 8000
```

Open the printed address and tap **New trip**, or **Try it with sample data**.

## 2. Publish on GitHub Pages

1. Optionally set `defaultCurrency` in `js/config.js`.
2. Commit and push to `main`.
3. On GitHub, open **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute the app is live at `https://dejagereric.github.io/trip-split/`.

Free GitHub Pages needs a **public** repo. Nothing secret is stored in the repo (see Privacy).

## 3. Install on each phone

- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**.
- **Android (Chrome):** open the link, tap **⋮ → Install app** (or *Add to Home screen*).

It then opens full screen with its own icon. The **Scan** button opens the rear camera.

## 4. Connect the shared database and receipt reading (Supabase)

Demo mode is per-phone. To have everyone's phones share trips and to read receipts automatically:

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: paste `supabase/schema.sql`, run it. That creates the `parties`, `trips` and `entries` tables, their access rules and the `receipts` photo bucket.
3. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com). Then deploy the receipt reader with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy extract-receipt --no-verify-jwt
   ```
   `--no-verify-jwt` is needed because the new `sb_publishable_…` keys aren't JWTs. The function guards itself instead: it only answers requests from a group that has at least one trip.
4. **Project Settings → API Keys**: copy the *Project URL* and the *publishable* key (or legacy *anon* key) into `supabaseUrl` and `supabaseAnonKey` in `js/config.js`. Bump `VERSION` in `sw.js`, then commit and push.
5. Open the app and tap **Create our group**. Send the resulting link (it ends in `#group=…`) to the people you travel with. Everyone opens that link and adds it to their home screen. The same link covers every trip.

The app checks for changes every 15 seconds while open, and whenever it comes back to the foreground.

**Cost:** Supabase's free tier is plenty. Each receipt scan is one small call to a Haiku-class model, a fraction of a cent.

## Privacy

- The repo holds only public settings. The Supabase anon key is meant to be public; the access rules do the protecting.
- Your group has a random **group id** that lives only in the share link. The database returns rows only to requests carrying that id, so anyone holding the link can see and edit the group's trips and people, including phone numbers and emails. Treat it like a shared-album link.
- Receipt photos sit in a public bucket under unguessable paths. Anyone with a photo's exact URL can view it, but the bucket can't be listed.
- The Anthropic key lives only in the Supabase function's secrets, never in the app.

## How the math works

- **Spent:** what a person paid out of pocket on this trip.
- **Benefitted:** the sum of their shares of the trip's expenses they took part in.
- **Net:** spent − benefitted, plus settle-up payments sent, minus payments received. Positive means they're owed money.
- **Settle up** pairs the largest debtor with the largest creditor until everyone is square. That's at most one payment fewer than the number of people.
- Amounts are stored in whole cents. Equal splits give any leftover cent to the first people in the split.

## Files

```
index.html               app shell
css/styles.css           styles
js/config.js             default currency, Supabase keys
js/app.js                screens and interactions
js/logic.js              balance and settle-up math (pure functions)
js/store.js              demo (localStorage) and Supabase storage
sw.js                    offline cache for the app shell
manifest.webmanifest     home-screen install settings
supabase/schema.sql      tables, access rules, photo bucket
supabase/functions/extract-receipt/index.ts   receipt reader
tests/logic.test.mjs     math tests (node tests/logic.test.mjs)
```

## Updating

Change files, bump `VERSION` in `sw.js`, push. Phones pick up the new version the next time the app opens online.
