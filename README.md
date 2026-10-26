# Trip Split

A phone web app for tracking shared vacation costs between **three parties**. Anyone can log an expense, choose who shares it (all three, or just two), scan the receipt, and see everyone's running totals. At the end, it shows the fewest payments that settle everything.

It's for tracking and communication only: no bank accounts, cards or payments.

No App Store or Google Play listing needed. It's a website you add to your home screen.

## Screens

- **Balances**: each person's total spent, total shared spending, and who would pay whom if you squared up now.
- **Add expense**: scan a receipt (fills in description, date and total), amount, date, category, who paid, who shares it, and an equal or exact-amount split.
- **Ledger**: every entry, filterable by person. Filtering shows that person's **Spent** and **Benefitted** totals.
- **Settle up**: the payments due, a Spent / Benefitted / Net breakdown, a summary to share in the group chat, and **Mark as paid** to record a settlement.

## 1. Try it locally (demo mode)

With `supabaseUrl` blank in `js/config.js`, the app runs in **demo mode**: data stays in one browser and receipts are attached but not read automatically.

```bash
npx serve .          # or: python3 -m http.server 8000
```

Open the printed address. On the empty Balances screen, tap **Try it with sample data**.

## 2. Publish on GitHub Pages

1. Edit `js/config.js`: set `tripName`, `currency` and the three party names. Keep the ids `A`, `B`, `C`.
2. Commit and push to `main`.
3. On GitHub, open **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute the app is live at `https://dejagereric.github.io/trip-split/`.

Free GitHub Pages needs a **public** repo. Nothing secret is stored in the repo (see Privacy).

## 3. Install on each phone

- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**.
- **Android (Chrome):** open the link, tap **⋮ → Install app** (or *Add to Home screen*).

It then opens full screen with its own icon. The **Scan** button opens the rear camera.

## 4. Connect the shared database and receipt reading (Supabase)

Demo mode is per-phone. To have all three phones see the same ledger and to read receipts automatically:

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: paste `supabase/schema.sql`, run it. That creates the `entries` table, its access rules and the `receipts` photo bucket.
3. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com). Then deploy the receipt reader with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy extract-receipt
   ```
4. **Project Settings → API**: copy the *Project URL* and the *anon public* key into `supabaseUrl` and `supabaseAnonKey` in `js/config.js`. Bump `VERSION` in `sw.js`, then commit and push.
5. Open the app, tap **Start a new trip**, and send the resulting link (it ends in `#trip=…`) to the other two. Everyone opens that link, then adds it to their home screen.

The app checks for new entries every 15 seconds while open, and whenever it comes back to the foreground.

**Cost:** Supabase's free tier is plenty for a trip. Each receipt scan is one small call to a Haiku-class model, a fraction of a cent.

## Privacy

- The repo holds only public settings. The Supabase anon key is meant to be public; the access rules do the protecting.
- Each trip has a random **trip id** that lives only in the share link. The database returns rows only to requests carrying that id, so anyone holding the link can read and edit the trip. Treat it like a shared-album link.
- Receipt photos sit in a public bucket under unguessable paths. Anyone with a photo's exact URL can view it, but the bucket can't be listed.
- The Anthropic key lives only in the Supabase function's secrets, never in the app.

## How the math works

- **Spent:** what a person paid out of pocket.
- **Benefitted:** the sum of their shares of the expenses they took part in.
- **Net:** spent − benefitted, plus settle-up payments sent, minus payments received. Positive means they're owed money.
- **Settle up** pairs the largest debtor with the largest creditor until everyone is square. With three parties that's at most two payments.
- Amounts are stored in whole cents. Equal splits give any leftover cent to the first person in the split.

## Files

```
index.html               app shell
css/styles.css           styles
js/config.js             trip name, currency, party names, Supabase keys
js/app.js                screens and interactions
js/logic.js              balance and settle-up math (pure functions)
js/store.js              demo (localStorage) and Supabase storage
sw.js                    offline cache for the app shell
manifest.webmanifest     home-screen install settings
supabase/schema.sql      database table, access rules, photo bucket
supabase/functions/extract-receipt/index.ts   receipt reader
tests/logic.test.mjs     math tests (node tests/logic.test.mjs)
```

## Updating

Change files, bump `VERSION` in `sw.js`, push. Phones pick up the new version the next time the app opens online.
