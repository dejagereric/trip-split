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

- **Trips / People / Access** (tap the trip name at the top):
  - Trips: create, rename, set dates and currency, switch, delete.
  - People: add, edit or delete people. Each has a name, phone, email and color, and can be filled in from your contacts.
  - Access (once connected): who can sign in, invites, sign out.
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
5. Optional custom domain (this repo uses **https://trips.ericdejager.com**): at your DNS host add a `CNAME` record `trips` → `dejagereric.github.io`, then enter the domain under **Settings → Pages → Custom domain** and tick **Enforce HTTPS** once GitHub issues the certificate. The github.io address then redirects to it.

Free GitHub Pages needs a **public** repo, and the page itself is public. That's fine: nothing secret is in the repo, and once Supabase is connected nobody sees any data without signing in (see Privacy).

## 3. Install on each phone

- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**.
- **Android (Chrome):** open the link, tap **⋮ → Install app** (or *Add to Home screen*).

It then opens full screen with its own icon. The **Scan** button opens the rear camera.

## 4. Connect the shared database, sign-in and receipt reading (Supabase)

Demo mode is per-phone. To share trips across phones, require sign-in and read receipts automatically:

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: paste `supabase/schema.sql`, run it. That creates the groups, members, people, trips and expenses tables, the access rules, and a **private** `receipts` photo bucket. It's safe to run again.
3. **Sign-in emails send a code, not a link.** In **Authentication → Emails → Templates**, edit both **Magic Link** and **Confirm signup**. Put the code in the message body, for example:
   ```html
   <h2>Your Trip Split code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   ```
   A code works inside the installed home-screen app. A link would open in the browser instead.
4. **Authentication → Sign In / Providers → Email**: make sure *Email* is enabled. Leave *Allow new users to sign up* on: anyone can request a code, but they see nothing until a group member adds their email.
5. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com). Then deploy the receipt reader with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   cp supabase/.env.example supabase/.env      # then paste your key into supabase/.env
   supabase secrets set --env-file supabase/.env
   supabase functions deploy extract-receipt --no-verify-jwt
   ```
   `supabase/.env` is gitignored, so your key stays on your computer for reference and never reaches GitHub. `--no-verify-jwt` is needed because the new `sb_publishable_…` keys aren't JWTs. The function checks the caller itself: they must be signed in and a member of the group.
6. **Project Settings → API Keys**: copy the *Project URL* and the *publishable* key into `supabaseUrl` and `supabaseAnonKey` in `js/config.js`. Bump `VERSION` in `sw.js`, then commit and push.
7. Open the app, enter your email, type the code, and tap **Create our group**. You're the group's owner.
8. Add the people you travel with under **Trips → Access → Give access** (or **People → a person → Let them sign in**). Tap **Invite** to email them the app link. They sign in with their own email; nothing to forward.

The app checks for changes every 15 seconds while open, and whenever it comes back to the foreground.

**Email limits:** Supabase's built-in email sender only allows a few emails per hour and is meant for testing. That's usually fine for a handful of people signing in once per phone. If codes stop arriving, set up your own email sender (for example Resend or Postmark) under **Authentication → Emails → SMTP Settings**.

**Cost:** Supabase's free tier is plenty. Each receipt scan is one small call to a Haiku-class model, a fraction of a cent.

## Privacy

- **Only approved email addresses get in.** The database itself checks that the signed-in, code-verified email is on the group's list before returning or changing anything. The app link alone is useless.
- **The group owner can remove anyone.** Members can add people and can leave. Removed people lose access on their next refresh.
- **Receipt photos are private.** They're shown through links that expire after an hour, and only to group members.
- **The repo holds only public settings.** The publishable key is meant to be public; the access rules do the protecting. Making the repo public (for free GitHub Pages) exposes the code, not your data.
- **The Anthropic key never reaches the app.** It lives only in the Supabase function's secrets, plus your gitignored `supabase/.env`.

## Currencies

- Each trip has a **trip currency**. Balances, settle-up and the spent tallies are in it. Set it when creating the trip; it's locked once the trip has expenses.
- Each trip also has **currencies you'll spend** (USD and EUR by default). On *Add expense*, tap the currency next to the amount to switch. Choosing another currency adds it to the trip's list. New expenses start in the last currency you used.
- Expenses in another currency are converted at **that day's rate** (Frankfurter mid-market rates, through the `fx-rate` Supabase function). You can type your card's actual rate instead. The rate is saved with the expense, so balances never shift later.
- The Ledger shows what was spent (for example €90.00) and its trip-currency value ($101.13).

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
