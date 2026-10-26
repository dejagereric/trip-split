# Trip Split: where we left off

_Last updated: October 26, 2026_

## Done

- **App** (this repo, `main`): trips, people (name / phone / email, contact picker), add / edit expenses with receipt scan, ledger with Spent / Benefitted filter, settle up with Text / Email, email-code sign-in, Access screen (give access, invite, remove, sign out).
- **Hosting:** GitHub Pages, now at **https://trips.ericdejager.com** (the github.io address redirects there).
- **Supabase project** `trip-split` (ref `pmutzpswuqvrtkdqplgs`):
  - Schema applied (migrations `email_signin_groups`, `move_access_helpers_to_private_schema`). Matches `supabase/schema.sql`.
  - Access rules tested in the live database (owner, outsider, member, signed-out), and no test data was left.
  - Security advisor: only `create_group` is flagged, and that's intentional.
  - Edge function `extract-receipt` deployed (`verify_jwt: false`; it checks sign-in and membership itself).
  - `ANTHROPIC_API_KEY` secret set (by Eric).
  - Custom SMTP set up (Gmail), and the Magic Link and Confirm signup templates now send `{{ .Token }}` codes.
- `js/config.js` has the project URL and publishable key.
- **Signed-in user ("you"):** a one-time Your details screen (name and phone). You're the default payer and sharer on new expenses (tap your name to take yourself off), new trips start with you, and expenses record who added them (`entries.created_by_email`).
- **Multi-currency (Oct 26):** each trip has a trip currency (ISO code) plus a short list of preferred currencies (`trips.currencies`, USD and EUR first). On an expense, tap the currency button to pick from the trip's list, or "Other currency" (that adds it to the trip). New expenses default to the last currency used. The day's rate comes from the `fx-rate` edge function (Frankfurter v2) and can be overridden. Stored per expense: `orig_amount_cents`, `orig_currency`, `fx_rate`, `fx_date`; `amount_cents` is always in the trip currency. Receipts set the currency. The Ledger shows both amounts. The trip currency is locked once the trip has expenses.
- **Ledger:** newest first (fixed order), Search, and Export (CSV now; Google Sheets once `googleClientId` is set; see README → Google Sheets export setup).
- **Categories:** `categories` table, shared per group, managed under Trips → Categories. Yacht charter and Boat expenses added. The receipt reader uses the group's list.
- **Roles (RBAC):** `group_members.role` is `admin` (Administrators) or `user` (Users). Eric is an Administrator. Row-level security: People (`parties`) writes are admin-only except a User's own record; Access (`group_members`) is admin-only (Users see only their own row); group rename/delete admin-only; a trigger keeps at least one admin. Tested in the live database with simulated Administrator, User and outsider (rolled back). No UI gating by design; refusals show "Only Administrators can do that."
- **Groups (Oct 26):** Access → Groups: create / open / rename / delete. Group creation is locked in the database (`private.settings.open_group_creation = false`; only existing Administrators may create). Uninvited sign-ins aren't offered a group. The current group is named "This is a test"; Eric plans to create a real group when testing is done, then delete or rename the test one.
- **Layout:** the app is pinned to the visible screen (fixed position), which fixes the tab bar dropping below the screen on Android.

## Next: custom domain `trips.ericdejager.com`

**Eric's domains, including ericdejager.com, are managed at GoDaddy** (godaddy.com → My Products → Domains → ericdejager.com → DNS).

Note (Oct 26): trips.ericdejager.com already answers with something before our record was added. That's probably a GoDaddy wildcard (`*`), forwarding or parked-page record. A specific `trips` record overrides it.

Do these in order (the DNS record must exist before GitHub switches addresses):

1. [x] GoDaddy DNS: add record type `CNAME`, name `trips`, value `dejagereric.github.io`, TTL default.
2. [x] Wait for DNS to take effect (minutes, up to an hour).
3. [x] GitHub repo → Settings → Pages → Custom domain: `trips.ericdejager.com` → Save. GitHub adds a `CNAME` file to the repo.
4. [x] **Enforce HTTPS** is on (Oct 26).
5. [ ] Optional: verify ericdejager.com under GitHub account → Settings → Pages (a TXT record).
6. [x] Claude: confirmed the site answers at the new address, and updated the README.

## Then: first real run

1. [ ] Open https://trips.ericdejager.com on a phone, sign in with the emailed code, create the group.
2. [ ] Add to the home screen, then sign in again inside the installed app (iPhone keeps it separate from Safari).
3. [ ] Create a trip, scan a real receipt, save an expense.
4. [ ] Access → Give access to one companion → Invite. Have them sign in and confirm they see the trip.
5. [ ] If anything fails, Claude checks the auth, database and function logs through the Supabase connector.

## Waiting on Eric

- [ ] Google Cloud OAuth client ID for Sheets export (README → Google Sheets export setup), then Claude puts it in `js/config.js`.
- [ ] Confirm the bottom tab bar now stays put on the Pixel (Balances and Ledger).

## Later / optional

- Update the design canvas (Claude Design artifact) to match the current app.
- In Supabase → Authentication → URL Configuration, set Site URL to `https://trips.ericdejager.com`. (Not needed for code sign-in.)
