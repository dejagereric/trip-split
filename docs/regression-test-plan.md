# Regression suite + staging gate for Trip Split

## Context
Today `main` deploys straight to https://trips.ericdejager.com (GitHub Pages) and `js/config.js` points at the one live Supabase project. The tests that exist cover pieces: unit tests for the math and CSV, 5 browser tests against an in-memory stand-in (`tests/browser/`), and SQL rule tests. Nothing runs them automatically. Nothing covers the core money workflows from start to finish: entering an expense, splits, currency, ledger, balances and settle up.

Goal: changes merge to a `staging` branch. A GitHub Action deploys staging to its own site and its own database and runs a risk-ranked regression suite against it. If the suite passes, the Action moves `main` to that exact commit, which publishes production.

Decisions made: staging is hosted in a second GitHub repo's Pages site, uses a second free Supabase project, and auto-promotes to `main` when it passes.

## 1. Pipeline

```
feature branch ──PR──▶ staging ──(Action)──▶ deploy staging site + DB ──▶ regression suite ──pass──▶ fast-forward main ──▶ production
                  PR checks: unit + hermetic browser tests (fast, no network)
```

**`.github/workflows/pr.yml`** runs on every PR into `staging`. It runs `node tests/logic.test.mjs`, `node tests/export.test.mjs`, `tests/browser/run.sh`, and the new suite in **hermetic** mode, which uses the stand-in Supabase. Branch protection on `staging` requires this check to pass.

**`.github/workflows/staging.yml`** runs on every push to `staging`, plus a weekly cron and a manual trigger. Its jobs run in this order:
1. **gate**: the same fast checks as the PR workflow.
2. **migrate-staging**: applies `supabase/schema.sql` to the staging database (it's idempotent) with `psql "$STAGING_DB_URL"`. Then it runs `supabase/tests/*.test.sql` through a small wrapper, `tests/regression/run-sql-tests.sh`. Each of those files raises an error on purpose to roll back, so the wrapper passes only when the error message contains no line that doesn't end in "ok". It also deploys the `fx-rate` and `extract-receipt` functions with `supabase functions deploy` when `supabase/functions/` changed.
3. **deploy-staging**: copies the site into the `dejagereric/trip-split-staging` repo and pushes it with a deploy key. Before copying it:
   - rewrites `js/config.js` with the staging Supabase URL and publishable key;
   - writes `CNAME` = `staging.trips.ericdejager.com`;
   - stamps `sw.js` VERSION and a new `version.txt` with the commit SHA.

   It then polls `https://staging.trips.ericdejager.com/version.txt` until it shows that SHA.
4. **reset-data**: `tests/regression/seed.mjs`, using the staging service-role key, deletes and recreates the fixture groups, people, trips, entries and categories, and the test users.
5. **regression**: `npx playwright test --project=staging` with the tiers chosen in section 3. It uploads the HTML report and traces of failures as artifacts.
6. **promote** (skipped on the weekly run):
   - **Commit changes app files only:** `git push origin <tested-sha>:main`, a fast-forward only. If `main` has moved, the push is refused and the job fails loudly instead of merging.
   - **Commit changes `supabase/`:** the job first applies `schema.sql` and deploys the functions to production, under a GitHub `production` environment that needs your one-click approval. Database changes can't be rolled back by reverting a commit, so they wait for you; app-only changes promote with no approval.

**Secrets** (repo → Settings → Secrets):
- **Staging:** `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_PUBLISHABLE_KEY`, `STAGING_SERVICE_ROLE_KEY`, `STAGING_DB_URL`, `SUPABASE_ACCESS_TOKEN`, `STAGING_DEPLOY_KEY`.
- **Production:** `PROD_DB_URL`, under the `production` environment.

The staging Supabase project needs its own `ANTHROPIC_API_KEY` function secret.

**One-time setup:**
- Create the staging repo with Pages from `main` / root.
- Add a GoDaddy CNAME `staging.trips` → `dejagereric.github.io`.
- Create the staging Supabase project:
  - leave the invite-only hook **off**, so seeding can create users;
  - keep email sign-up on.
- Protect branches:
  - `main`: only the Action pushes;
  - `staging`: PR plus the passing check.
- Document all of this in README → *Releasing* and STATUS.

## 2. Test framework
- Add a `package.json` (devDependencies: `@playwright/test`, pinned) and `playwright.config.mjs` with two projects. Both use the Pixel 7 device and HTML reporter, retries 1 on staging and 0 in hermetic mode.
  - **hermetic**: serves the repo with `python3 -m http.server` (`webServer`) and routes supabase-js to `tests/browser/stand-in-supabase.mjs`.
  - **staging**: `baseURL` = staging site, signed in as real test users.
- **`tests/regression/fixtures.mjs`** holds the shared Playwright fixtures, so each spec runs in both modes unchanged.
  - `as(role)` gives a page signed in as `admin` (Ada), `user` (Uma) or `outsider`.
  - Hermetic: reuse the `session()` setup in `tests/browser/permissions.test.cjs`, which routes the supabase-js URL and seeds `window.__db` / `window.__me`, and move it into the fixture.
  - Staging: sign in once per role in `globalSetup` with supabase-js `auth.admin.generateLink({type:'magiclink'})` → `verifyOtp`. Save the session into Playwright `storageState` (localStorage `sb-<ref>-auth-token`). No email is sent.
  - Set `tripsplit:askedDetails:<group>` the way the existing tests do.
- **`tests/regression/seed-data.mjs`** holds one fixture dataset shared by both modes: the `seed()` from the existing tests, extended. The hermetic fixture loads it into `window.__db`, and `seed.mjs` writes it to staging.
  - One group, with Ada (Administrator) and Uma (User), plus Paul (no sign-in).
  - Trip "Regression USD" with known entries.
  - Trip "Regression EUR" (trip currency EUR).
  - A trip with people and cabin weights for the 3 families.
  - An inactive trip.
- **Page helpers** go in `tests/regression/pages/`: `expenseForm`, `ledger`, `balances`, `settle`, `tripEdit`. They're built on the `data-action` attributes the app already uses (`save`, `mode`, `toggleCur`, `editExpense`, `del`, `record`, `toggleSearch`, `exportCsv`, …), so the app needs no markup changes except a few `data-testid`s where text is ambiguous.
- **Oracle for amounts:** expected values are written out by hand in the specs (e.g. `$100.00 split 3 ways → 33.34/33.33/33.33`). Each core spec also checks consistency: the Ledger total equals the sum of Spent on Balances, nets add up to 0, and applying the Settle up payments leaves every net at 0.
- **Tags in test titles:** priority `@p1`/`@p2`/`@p3`, area `@expense @split @currency @ledger @balances @settle @receipt @trips @people @categories @export @profile @auth @access @groups @invites @pwa @security`, and `@staging-only` for tests that need the real backend.
- **Live currency rates:** tests that use live rates use **past dates** (e.g. 2026-10-15), whose published rates never change. Expected values are calculated from the rate the app shows, and one test pins a hand-typed rate so the math is exact.

## 3. Risk-based tiers and impact selection

| Tier | What | When it runs |
|---|---|---|
| **P1 core**: expense, split, currency, ledger, balances, settle | the money workflows; wrong numbers here break trust | **every** staging run, every PR (hermetic), whatever changed |
| **P2 regular**: trips, people, categories, receipt scan, export, profile/payment links, the main role rules, sign-in | used every trip, but less often or with less at stake | when its area is affected by the change, plus a 1-test smoke per area on every run |
| **P3 infrequent admin**: groups create/rename/delete, invitations, giving and removing access, deleting people, roles, inactive trips and deleting trips | rare; mostly covered by the SQL rule tests | only when its area is affected, plus the **weekly full run** |

**`tests/regression/select.mjs`** decides what to run.
1. It diffs `origin/main...HEAD`, so everything not yet in production is included and a failed run's changes are tested again on the next run.
2. It maps the diff to areas through **`tests/regression/impact-map.json`**. Whole files map directly:
   - `js/logic.js` → expense/split/balances/settle;
   - `js/payments.js` → settle/profile;
   - `js/export.js` → export;
   - `supabase/functions/fx-rate` → currency;
   - `extract-receipt` → receipt;
   - `supabase/schema.sql` → all role rules plus trips/groups/invites;
   - `sw.js`/`manifest` → pwa;
   - `index.html` CSP → security.
3. `js/app.js` is one 2,244-line file, so the map lists its **function names** → areas, for example:
   - `addHtml`, `evalForm`, `setFormField`, `ensureRate` → expense/split/currency;
   - `ledgerHtml`, `ledgerListHtml`, `searchText` → ledger;
   - `settleHtml`, `summaryText`, `payButtons` → settle;
   - `accessHtml`, `inviteControls` → access/invites;
   - `tripEditHtml`, `deletePlan` → trips.

   The script finds which top-level `function`/`const … =>` blocks contain the changed lines (a small regex scan of the file) and looks up their areas.
4. **Safety rule:** a change it can't map runs **everything**. That includes `store.js`, `render`, `boot`, `refresh`, `commit`, `css`, `config`, a new function, or a deleted function.
5. It prints the chosen `--grep` (e.g. `@p1|@smoke|@trips|@categories`) and writes it to the job summary, so you can see what ran and why.

A unit test, `tests/regression/select.test.mjs`, checks the mapping. A CI check fails when `app.js` gains a function that isn't in the map, so the map can't fall behind.

## 4. Test inventory (new files in `tests/regression/`)

**P1 (target ~60 tests):**
- `expense.spec.mjs`:
  - adding an expense saves its amount, description, date, category and payer, and it appears in the Ledger and Recent;
  - editing and deleting it;
  - checks on bad amounts (0, negative, letters, `1,5`);
  - you are the default payer and sharer;
  - taking yourself off the sharers;
  - adding a person from *+ Add person*;
  - a payment entry (`record`);
  - saving offline or after an error rolls back (`commit` undo).
- `split.spec.mjs`:
  - Equally, with leftover cents going to the first people;
  - By people (4:3:3) and By cabins (2:1:1), filled in from the trip, with changes for one expense only, and leftover cents going to the largest remainders;
  - Exact, which must add up to the total;
  - the trip's default split;
  - changing the trip's weights afterwards doesn't alter past expenses;
  - leaving a person out.
- `currency.spec.mjs`:
  - switching the currency button;
  - "Other currency" adds it to the trip's list;
  - the next expense starts in the last currency used;
  - the day's rate on a past date;
  - typing your own rate;
  - the Ledger shows both amounts;
  - the saved rate doesn't shift later;
  - the trip currency locks once the trip has expenses;
  - an EUR trip;
  - splits in a foreign currency convert to the exact trip-currency total.
- `ledger.spec.mjs`:
  - newest first, with same-day entries in the order they were added;
  - the filter by person shows Spent/Benefitted;
  - Search by text, category, person, amount `90`, currency, date `oct 15`, and several words;
  - opening an entry shows the receipt, Edit and Delete;
  - "Moved from …" entries.
- `balances-settle.spec.mjs`:
  - Spent / Benefitted / Net on the fixture trip;
  - the fewest payments, at most one fewer than the number of people;
  - Mark as paid sets the nets to 0;
  - Text/Email links contain the amount;
  - Pay-app buttons (Venmo/Cash App in USD only);
  - the "Include payment links" toggle;
  - the shared summary text;
  - consistency checks (section 2).
- `roles-core.spec.mjs`: a User edits and deletes only their own expenses; an Administrator can edit anyone's; an inactive trip's expenses are read-only. Move the existing `tests/browser/permissions.test.cjs` checks here.

**P2:**
- `trips.spec.mjs`: create a trip, then "Who's coming?"; rename; dates; switch trips; remove a person but keep their existing expenses.
- `people.spec.mjs`: add, edit, color, contact picker (stubbed), and the Get paid back fields.
- `categories.spec.mjs`: add, rename (relabels expenses), reorder (Administrators only), delete.
- `receipt.spec.mjs`:
  - attach and view a receipt;
  - **@staging-only** reading a receipt: a fixture `receipt.jpg` fills in total, date and description, checked loosely;
  - removing a receipt.
- `export.spec.mjs`: the CSV download's content matches the trip, with formula injection neutralized. Google Sheets stays out until `googleClientId` is set.
- `profile.spec.mjs`: the initials button, saving Your profile, and Back returns to where you were.
- `auth.spec.mjs` **@staging-only**:
  - sign in with a code: intercept `/auth/v1/otp` and use the `generateLink` code;
  - sign out;
  - an outsider sees nothing.
- `pwa-security.spec.mjs`: move the existing `csp.test.mjs`, and add a test that the update banner appears when `version.txt`/`sw.js` changes.

**P3:**
- `groups.spec.mjs`: create, switch, rename, delete with the typed name. Extend the existing `groups.test.cjs`.
- `invites.spec.mjs`:
  - **@staging-only:** create an invitation, open the link while signed out (`invite_preview`), accept it, check the role it gives, then cancel an invitation;
  - in both modes: invitations expire and work only once.
- `access.spec.mjs`: give and remove access, change a role, the last Administrator can't be removed.
- `trip-lifecycle.spec.mjs`: move the existing `trip-lifecycle.test.cjs` here: inactive trips, `delete_trip` moving other people's entries.
- `demo.spec.mjs`: move the existing `demo-mode.test.cjs` here.

After the move, `tests/browser/run.sh` points at the new suite's hermetic project, so there aren't two copies of the same checks.

## 5. Order of work
1. Framework: `package.json`, config, fixtures, seed data, page helpers, one P1 spec, all running in hermetic mode locally.
2. The rest of P1, then P2, then P3. Port the existing tests as their areas come up.
3. `select.mjs`, the impact map and its tests.
4. `pr.yml`.
5. Staging resources and secrets, with your help. Then `staging.yml` without the promote job, running on the weekly cron and manual trigger, until it's green.
6. Turn on promote and branch protection. Update the README (*Releasing*, *Tests*) and STATUS.

## 6. Verification
- Locally: `npx playwright test --project=hermetic` passes, and `--grep @p1` runs only core.
- `node tests/regression/select.mjs --base <sha>` on past commits picks sensible areas:
  - `1abb1b7` (tests only) → P1 + smoke;
  - `2eacb5f` (groups) → P1 + `@groups`;
  - a change to `store.js` → everything.
- Break things on purpose in a throwaway branch: change `splitWeighted` remainder handling, or remove `ensureRate`. The PR check and the staging run must fail on the right specs, and `main` must not move.
- A clean change pushed to `staging` deploys to staging.trips.ericdejager.com, passes, and `main` fast-forwards to the same SHA. The production site then serves the new `version.txt`.
- The weekly run executes every P3 test and doesn't promote.
