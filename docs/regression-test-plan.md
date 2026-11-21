# Regression suite + staging gate for Trip Split

## Context
Today `main` deploys straight to https://trips.ericdejager.com (GitHub Pages) and `js/config.js` points at the one live Supabase project. The tests that exist cover pieces: unit tests for the math and CSV, 5 browser tests against an in-memory stand-in (`tests/browser/`), and SQL rule tests. Nothing runs them automatically. Nothing covers the core money workflows from start to finish: entering an expense, splits, currency, ledger, balances and settle up.

Goal: changes merge to a `staging` branch. A GitHub Action deploys staging to its own site and its own database and runs a risk-ranked regression suite against it. If the suite passes, the Action moves `main` to that exact commit, which publishes production. A failure comes back to you as an issue, and `main` doesn't move. Above all, a release must not interrupt people using the app: not through broken code, and not through a database change.

Decisions made: staging is hosted in a second GitHub repo's Pages site, uses a second free Supabase project, and auto-promotes to `main` when it passes.

## 1. Rules every release follows

These keep a release from interrupting people. The pipeline checks them where it can.

- **Database changes only add things.** A release may add tables, columns (nullable or with a default), functions, triggers and rules, and may loosen a rule. It may not drop or rename a column, table or function, or tighten a rule the current app relies on. Removing something takes two releases: first an app that no longer uses it, then the database change, once the old app is gone (at least a day later). Reason: production's database changes first, and installed phones keep running the old app until they reload.
- **The old app must work against the new database.** Every run checks this (section 2, job 5).
- **Every release bumps `VERSION` in `sw.js`.** That's what shows the "A new version is ready" banner (`js/app.js` listens for the service worker changing). The PR check fails if a shipped file changed and `VERSION` didn't.
- **`schema.sql` stays safe to re-apply.** Each one-time conversion (`update … where …`) must change nothing on a second run. The migrate job applies the file twice and fails if the second run changes any row.

## 2. Pipeline

```
feature branch ──PR──▶ staging ──(Action)──▶ upgrade staging DB ──▶ deploy staging site ──▶ regression suite ──pass──▶ fast-forward main ──▶ check production
                  PR checks: unit + hermetic browser tests (fast, no network)                                    └─fail──▶ issue + revert PR, main stays put
```

**`.github/workflows/pr.yml`** runs on every PR into `staging`:
- `node tests/logic.test.mjs`, `node tests/export.test.mjs`, and the whole regression suite in **hermetic** mode (the stand-in Supabase, no network);
- `tests/regression/check-version.mjs`: fails if any file listed in `sw.js` `SHELL`, or `sw.js` itself, changed against `staging` and `VERSION` didn't;
- `tests/regression/check-csp.mjs`: the Supabase address in `index.html`'s Content-Security-Policy (`img-src` and `connect-src`) matches `js/config.js`.

Branch protection on `staging` requires this check to pass.

**`.github/workflows/staging.yml`** runs on every push to `staging`, twice a week on a schedule (Monday and Thursday, so the free Supabase project never reaches its 7-day pause), and on a manual trigger.

It has `concurrency: { group: staging, cancel-in-progress: false }`, so runs queue rather than overlap: a second run would otherwise reset the test data while the first is still testing. The promote job (job 7) runs outside this group, so waiting for your approval doesn't hold up later runs.

Every job checks out the **tested SHA** (`github.sha` of the triggering push) and never the current tip of `staging`.

1. **gate**: the same checks as `pr.yml`.

2. **guard**: refuses to continue unless `STAGING_SUPABASE_URL` and `STAGING_DB_URL` both contain the staging project ref and neither contains the production ref `pmutzpswuqvrtkdqplgs`. `seed.mjs` and `run-sql-tests.sh` repeat the same check themselves, so a wrong secret can never wipe production.

3. **migrate-staging**: tests the upgrade from production's database, not just a fresh one.
   1. Rebuild the staging database as production has it now:
      - drop and re-create the app's tables, functions and rules (`tests/regression/reset-staging-db.sql`, which drops the `public` app tables, the `private` schema and the receipt objects; it never touches `auth`);
      - apply **`main`'s** `schema.sql` (`git show origin/main:supabase/schema.sql`);
      - load the seed data (`seed.mjs --phase=before`), including rows in the older shapes that the conversions in `schema.sql` handle: `owner`/`member` roles, currency symbols, trips and categories with no `created_by_email`.
   2. Apply the **new** `schema.sql`, timing it:
      ```
      psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/schema.sql
      ```
      - `ON_ERROR_STOP=1` makes any error fail the step. Without it psql carries on and reports success.
      - `--single-transaction` makes the whole file land at once or not at all. Without it, each `drop policy` / `create policy` pair would leave its table with no rules for a moment, and people would see empty trips or failed saves.
      - The job summary records how long the file took. A run over 5 seconds is flagged, since the transaction holds locks while it runs.
   3. Check the upgraded data (`tests/regression/check-upgrade.sql`): roles are `admin`/`user`, currencies are ISO codes, every trip and category has a `created_by_email`, and the number of rows per table is unchanged.
   4. Apply the new `schema.sql` a second time, with the same flags. The step fails if this second run changes any row (it compares per-table row counts and a checksum of the `created_by_email`, `role` and `currency` columns before and after).
   5. Run `supabase/tests/*.test.sql` through `tests/regression/run-sql-tests.sh`. Each file ends with `raise exception '<NAME> TEST REPORT (rolled back):%'` on purpose, so everything it did is rolled back. The wrapper:
      - runs each file with `psql -v ON_ERROR_STOP=1` and captures the error message;
      - fails if the message has no `TEST REPORT (rolled back):` header, which would mean the file broke for some other reason;
      - ignores the header line, then fails if any remaining line doesn't end in `: ok`;
      - fails if the number of `ok` lines is below the count in `tests/regression/sql-test-counts.json` (today `group_creation` 11, `rbac_creator_rules` 31, `trip_lifecycle` 23), so a file that quietly runs fewer checks can't pass. Adding checks means raising the count in the same commit.
   6. Deploy both edge functions to staging every run (it's quick, and it keeps staging in step even after a failed run):
      ```
      supabase functions deploy fx-rate --no-verify-jwt --project-ref "$STAGING_REF"
      supabase functions deploy extract-receipt --no-verify-jwt --project-ref "$STAGING_REF"
      ```
      `--no-verify-jwt` matches how production runs them: both check sign-in themselves (see the header of each `index.ts`). Leaving it off would turn Supabase's own check back on.

   **Database addresses:** `STAGING_DB_URL` and `PROD_DB_URL` must be each project's **session pooler** address (`postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres`). The direct `db.<ref>.supabase.co` address is IPv6-only, and GitHub-hosted runners have no IPv6.

4. **deploy-staging**: builds the staging copy of the site in a temporary folder, then pushes it to `dejagereric/trip-split-staging` with a deploy key. In the copy it:
   - rewrites `js/config.js` with the staging Supabase URL and publishable key;
   - rewrites the production Supabase address in `index.html`'s Content-Security-Policy (`img-src` and `connect-src`) to the staging one, then fails if the production ref still appears anywhere in the copy;
   - writes `CNAME` = `staging.trips.ericdejager.com` and a `robots.txt` that disallows everything;
   - copies the current production site (`origin/main`, with the same rewrites) into `prev/`, for the old-app check in job 5.

   `sw.js` is copied unchanged. The `VERSION` it carries is the one that will ship to production.

   It then waits for GitHub Pages to serve the new copy. Pages caches each file separately for up to 10 minutes, so waiting on one marker file isn't enough. `tests/regression/wait-for-deploy.mjs` fetches every shipped file (the `SHELL` list in `sw.js`, at the root and under `prev/`) until each one's bytes match the copy that was pushed, or gives up after 15 minutes.

5. **regression**: resets the test data with `seed.mjs` (the staging service-role key). It deletes and re-creates the fixture groups, people, trips, entries, categories and test users. Then it runs:
   - `npx playwright test --project=staging`: the full suite against the new site;
   - `npx playwright test --project=staging-prev --grep @p1`: the core tests from `origin/main` (checked out into `prev-tests/`) against `/prev/` on the **upgraded** database. This is the old app that phones keep running until they reload. If it fails, the database change isn't backward compatible (section 1).

   Both upload the HTML report and traces of failures as artifacts. `retries: 1` stays on staging, but a test that passed only on its retry is listed in the job summary under **Flaky**, and any flaky `@p1` test is reported in the weekly issue (job 8) so it gets fixed rather than ignored.

6. **report-failure**: runs only if an earlier job failed, and on scheduled runs too (see job 8). It opens (or updates) one issue labelled `staging-failed`. The issue holds:
   - the failing job and tests, with a link to the run and its report;
   - the commits on `staging` not yet on `main`, and the PRs they came from (the PRs also get a comment linking the issue);
   - a link to a ready-made revert PR into `staging`, opened by the job, which reverts the PR the failing push merged.

   While that issue is open, `staging` holds untested or broken work. The next push is tested against everything not yet on `main`, so fixing forward is fine as well. The job closes the issue on the next green run. GitHub's merge queue, which would test before merging, isn't available for repos on a personal account, so this is the substitute.

7. **promote** (pushes only; skipped on scheduled and manual runs). It first checks that `origin/main` is an ancestor of the tested SHA and fails loudly if not.
   - **Commit changes app files only:** `git push origin <tested-sha>:main`, a fast-forward only.
   - **Commit changes `supabase/`:** the job runs under a GitHub `production` environment that needs your one-click approval. Database changes can't be undone by reverting a commit, so they wait for you; app-only changes promote with no approval. Once approved, the job checks out the tested SHA and, in this order:
     1. runs the same guard as job 2 in reverse: `PROD_DB_URL` must contain the production ref;
     2. applies `schema.sql` with `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/schema.sql`;
     3. deploys both functions with `--no-verify-jwt --project-ref pmutzpswuqvrtkdqplgs`;
     4. pushes the tested SHA to `main` (fast-forward).

     If step 4 is refused because `main` moved, production's database is ahead of its app. Because database changes only add things (section 1), the current app keeps working, and the next green run promotes the app. The job still fails, so you see it.
   - Approvals expire after 24 hours, and a later green run with the same `supabase/` change asks again.

8. **weekly** (the scheduled runs): jobs 1–5 run the **whole** suite including every P3 test, and nothing is promoted. They catch changes outside the repo: Supabase upgrades, the exchange-rate service, the receipt reader. A failure opens the same `staging-failed` issue. The Monday run also lists any flaky tests from the past week.

**`.github/workflows/check-production.yml`** runs after every push to `main` (triggered by `workflow_run` on `staging.yml`'s promote job, since a push made with the Actions token doesn't start other workflows):
- waits for Pages to serve the new production files, the same way as job 4;
- loads https://trips.ericdejager.com in Chromium signed out and checks: no script errors, no requests blocked by the Content-Security-Policy, the sign-in screen appears, and `sw.js` has the new `VERSION`;
- signs in as a dedicated production test account (`regression-prod@…`, User in a group of its own called "Regression check", with one trip) and checks that Balances and Ledger show its known numbers. It only reads; it never saves anything;
- on failure, opens a `production-failed` issue with a link to the rollback workflow.

**`.github/workflows/rollback.yml`** (manual, input: the SHA to return to, defaulting to the commit before the last promotion):
- makes a commit on top of `main` that restores the app files exactly as they were at that SHA (`git checkout <sha> -- . ':!supabase'`, and `git rm` any app file added since), keeps `VERSION` higher than the current one so phones see the banner, and pushes it to `main` (a fast-forward);
- merges `main` back into `staging`, so the next promotion is still a fast-forward;
- runs `check-production.yml`;
- never touches the database. Because database changes only add things, the earlier app works against it.

**Secrets** (repo → Settings → Secrets):
- **Staging:** `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_PUBLISHABLE_KEY`, `STAGING_SERVICE_ROLE_KEY`, `STAGING_DB_URL` (session pooler), `STAGING_REF`, `SUPABASE_ACCESS_TOKEN`, `STAGING_DEPLOY_KEY`.
- **Production** (under the `production` environment): `PROD_DB_URL` (session pooler), `PROD_SUPABASE_ACCESS_TOKEN` for deploying the functions.
- **Production check:** `PROD_CHECK_SERVICE_ROLE_KEY`, used only to sign in the production test account through `generateLink` (no email is sent).
- **`MAIN_PUSH_KEY`:** a deploy key with write access, used by promote and rollback to push to `main`.

The staging Supabase project needs its own `ANTHROPIC_API_KEY` function secret.

**One-time setup:**
- Create the staging repo with Pages from `main` / root.
- Add a GoDaddy CNAME `staging.trips` → `dejagereric.github.io`.
- Create the staging Supabase project the same way as production:
  - turn the invite-only hook **on** (Authentication → Hooks → Before User Created → `public.hook_invite_only_signup`), as in production. The seed adds each test user's group membership before creating the user, and the hook lets in anyone who already has a membership;
  - use the same Magic Link / Confirm signup templates (`{{ .Token }}` codes) and keep email sign-up on.
- Create the production test account and its "Regression check" group (step 5 of section 6).
- Protect branches, using a **ruleset** for each (classic branch protection can only limit who pushes on organization repos):
  - `main`: blocks pushes and force pushes, with `MAIN_PUSH_KEY` (the deploy key) allowed to bypass;
  - `staging`: requires a PR and the passing `pr.yml` check.
- Confirm in step 5 of section 6 that a push with `MAIN_PUSH_KEY` publishes Pages. Pushes made with the Actions token don't start other workflows, which is why promote uses the deploy key.
- Document all of this in README → *Releasing* and STATUS.

## 3. Test framework
- Add a `package.json` (devDependencies: `@playwright/test`, pinned) and `playwright.config.mjs` with three projects. All use the Pixel 7 device and the HTML reporter, retries 1 on staging and 0 in hermetic mode.
  - **hermetic**: serves the repo with `python3 -m http.server` (`webServer`) and routes supabase-js to `tests/browser/stand-in-supabase.mjs`.
  - **staging**: `baseURL` = staging site, signed in as real test users.
  - **staging-prev**: `baseURL` = staging site + `/prev/`, `testDir` = `prev-tests/tests/regression` (the specs from `origin/main`), same test users.
- **`tests/regression/fixtures.mjs`** holds the shared Playwright fixtures, so each spec runs in both modes unchanged.
  - `as(role)` gives a page signed in as `admin` (Ada), `user` (Uma) or `outsider` (Olly).
  - Hermetic: reuse the `session()` setup in `tests/browser/permissions.test.cjs`, which routes the supabase-js URL and seeds `window.__db` / `window.__me`, and move it into the fixture.
  - Staging: sign in once per role in `globalSetup` with supabase-js `auth.admin.generateLink({type:'magiclink'})` → `verifyOtp`. Save the session into Playwright `storageState` (localStorage `sb-<ref>-auth-token`). No email is sent.
  - Set `tripsplit:askedDetails:<group>` the way the existing tests do.
- **`tests/regression/seed-data.mjs`** holds one fixture dataset shared by both modes: the `seed()` from the existing tests, extended. The hermetic fixture loads it into `window.__db`, and `seed.mjs` writes it to staging.
  - The group "Regression", with Ada (Administrator) and Uma (User), plus Paul (no sign-in).
  - The group "Other group", with Olly as its only member. Olly is the outsider to "Regression", and the membership is what lets the invite-only hook admit him.
  - Trip "Regression USD" with known entries.
  - Trip "Regression EUR" (trip currency EUR).
  - A trip with people and cabin weights for the 3 families.
  - An inactive trip.
  - `seed.mjs --phase=before` (section 2, job 3) also writes rows in older shapes, which the upgrade must convert.
  - `seed.mjs` creates memberships first, then users, so the invite-only hook admits them.
- **Page helpers** go in `tests/regression/pages/`: `expenseForm`, `ledger`, `balances`, `settle`, `tripEdit`. They're built on the `data-action` attributes the app already uses (`save`, `mode`, `toggleCur`, `editExpense`, `del`, `record`, `toggleSearch`, `exportCsv`, …), so the app needs no markup changes except a few `data-testid`s where text is ambiguous.
- **Oracle for amounts:** expected values are written out by hand in the specs (e.g. `$100.00 split 3 ways → 33.34/33.33/33.33`). Each core spec also checks consistency: the Ledger total equals the sum of Spent on Balances, nets add up to 0, and applying the Settle up payments leaves every net at 0.
- **Tags in test titles:** priority `@p1`/`@p2`/`@p3`, `@smoke` on one quick test per P2 area, area `@expense @split @currency @ledger @balances @settle @receipt @trips @people @categories @export @profile @auth @access @groups @invites @pwa @security`, `@staging-only` for tests that need the real backend, and `@live` for tests that call an outside service (the exchange-rate service, the receipt reader).
- **Live currency rates:** tests that use live rates use **past dates** (e.g. 2026-10-15), whose published rates never change. Expected values are calculated from the rate the app shows. One `@p1` test pins a hand-typed rate so the math is exact, and that one blocks a release. The `@live` tests retry 3 times, and if they still fail only because the outside service didn't answer (a network error or a 5xx from it, recorded by the test), they're reported as a warning and don't block promotion. Any other failure in them blocks as usual.

## 4. Priority tiers and what runs when

| Tier | What | Why |
|---|---|---|
| **P1 core**: expense, split, currency, ledger, balances, settle | the money workflows | wrong numbers here break trust |
| **P2 regular**: trips, people, categories, receipt scan, export, profile/payment links, the main role rules, sign-in | used every trip | less at stake than the money |
| **P3 infrequent admin**: groups create/rename/delete, invitations, giving and removing access, deleting people, roles, inactive trips and deleting trips | rare | mostly covered by the SQL rule tests too |

**What runs, to start with:** every PR runs the whole hermetic suite. Every push to `staging` runs the whole staging suite, all tiers. The tiers order the work in section 6 and the order tests run in (P1 first, so a money failure shows up early), but nothing is skipped.

**Choosing tests by change is a later, optional step.** Build `select.mjs` only if the full staging run takes more than 10 minutes once all specs exist. Measure it at the end of step 3 in section 6. If it's built, it follows these rules:
1. It diffs `origin/main...<tested-sha>`, so everything not yet in production is included and a failed run's changes are tested again on the next run.
2. **Always run:** P1, every `@smoke` test, and every spec file that changed in the diff.
3. Whole files map to areas through `tests/regression/impact-map.json`:
   - `js/logic.js` → expense/split/balances/settle;
   - `js/payments.js` → settle/profile;
   - `js/export.js` → export;
   - `supabase/functions/fx-rate` → currency;
   - `supabase/functions/extract-receipt` → receipt;
   - `sw.js`/`manifest.webmanifest` → pwa;
   - `index.html` → security, plus everything if anything other than the Content-Security-Policy changed.
   - `supabase/schema.sql` → **everything**: its triggers (`stamp_creator`, `trip_state`, `rename_category_in_entries`) and `add_to_trip` sit in the expense and category paths, not only access.
4. `js/app.js` is mapped by top-level function **and** by each handler inside `const actions = { … }` (`js/app.js:1426` onward, about 45 handlers). Treated as one block, `actions` would make almost every change "unmapped". Its handler names match the `data-action` attributes, which keeps the map readable. Examples:
   - functions `addHtml`, `evalForm`, `setFormField`, `ensureRate` → expense/split/currency; handlers `save`, `mode`, `toggleCur` → expense/split/currency;
   - functions `ledgerHtml`, `ledgerListHtml`, `searchText` → ledger; handlers `toggleSearch`, `editExpense`, `del` → ledger/expense;
   - functions `settleHtml`, `summaryText`, `payButtons` → settle; handler `record` → settle/expense;
   - functions `accessHtml`, `inviteControls` → access/invites;
   - functions `tripEditHtml`, `deletePlan` → trips.

   The script finds the enclosing block of each changed line by scanning for top-level `function name(` / `const name =` and, inside `actions`, two-space-indented `name(` / `name:` keys.
5. **Safety rule:** a change it can't map runs **everything**. That includes `store.js`, `config.js`, `css/`, `render`, `boot`, `refresh`, `commit`, the event listeners at the bottom of `app.js`, the `actions.go` override, top-level constants, and any new, renamed or deleted function or handler.
6. It prints the chosen `--grep` and the reason for each area into the job summary.

A unit test, `tests/regression/select.test.mjs`, checks the mapping against past commits. A PR check fails when `app.js` gains a function or `actions` handler that isn't in the map, so the map can't fall behind.

## 5. Test inventory (new files in `tests/regression/`)

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
  - the day's rate on a past date (`@live`);
  - typing your own rate (blocks a release, section 3);
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
  - consistency checks (section 3).
- `roles-core.spec.mjs`: a User edits and deletes only their own expenses; an Administrator can edit anyone's; an inactive trip's expenses are read-only. Move the existing `tests/browser/permissions.test.cjs` checks here.

**P2:**
- `trips.spec.mjs`: create a trip, then "Who's coming?"; rename; dates; switch trips; remove a person but keep their existing expenses.
- `people.spec.mjs`: add, edit, color, contact picker (stubbed), and the Get paid back fields.
- `categories.spec.mjs`: add, rename (relabels expenses), reorder (Administrators only), delete.
- `receipt.spec.mjs`:
  - attach and view a receipt;
  - **@staging-only @live** reading a receipt: a fixture `receipt.jpg` fills in total, date and description, checked loosely;
  - removing a receipt.
- `export.spec.mjs`: the CSV download's content matches the trip, with formula injection neutralized. Google Sheets stays out until `googleClientId` is set.
- `profile.spec.mjs`: the initials button, saving Your profile, and Back returns to where you were.
- `auth.spec.mjs` **@staging-only**:
  - sign in with a code: intercept `/auth/v1/otp` and use the `generateLink` code;
  - sign out;
  - an outsider (Olly) sees nothing of "Regression".
- `pwa-security.spec.mjs`:
  - move the existing `csp.test.mjs` here, and add: no request is blocked by the Content-Security-Policy while using the app (listen for `securitypolicyviolation`);
  - the update banner: open the app, then serve an `sw.js` with a different `VERSION` (hermetic: a route; staging: not needed) and bring the page back to the front; the banner appears and Refresh loads the new files;
  - an app that is already installed with the previous `sw.js` cache picks up the new files on reload, rather than its cached copies.

**P3:**
- `groups.spec.mjs`: create, switch, rename, delete with the typed name. Extend the existing `groups.test.cjs`.
- `invites.spec.mjs`:
  - **@staging-only:** create an invitation, open the link while signed out (`invite_preview`), sign up as a new email through the link (the invite-only hook must let them in), accept it, check the role it gives, then cancel an invitation;
  - **@staging-only:** a new email with no invitation is refused at sign-up with the "invitation-only" message;
  - in both modes: invitations expire and work only once.
- `access.spec.mjs`: give and remove access, change a role, the last Administrator can't be removed.
- `trip-lifecycle.spec.mjs`: move the existing `trip-lifecycle.test.cjs` here: inactive trips, `delete_trip` moving other people's entries.
- `demo.spec.mjs`: move the existing `demo-mode.test.cjs` here.

**SQL:** add `supabase/tests/invite_hook.test.sql`, which calls `hook_invite_only_signup` directly: an email with a membership, one with a live invitation, a valid invite token, an expired invitation and an unknown email (refused). Add its count to `sql-test-counts.json`.

After the move, `tests/browser/run.sh` points at the new suite's hermetic project, so there aren't two copies of the same checks.

## 6. Order of work
1. Framework: `package.json`, config, fixtures, seed data, page helpers, one P1 spec, all running in hermetic mode locally.
2. `pr.yml`, with `check-version.mjs` and `check-csp.mjs`. **Prove the gate:** in a throwaway branch, change `splitWeighted`'s remainder handling, remove `ensureRate`, and change a shipped file without bumping `VERSION`. Each PR must fail on the right check.
3. The rest of P1, then P2, then P3. Port the existing tests as their areas come up. Add `invite_hook.test.sql`. Time the full suite; build `select.mjs` (section 4) only if it's over 10 minutes.
4. `run-sql-tests.sh`, `sql-test-counts.json`, `reset-staging-db.sql`, `check-upgrade.sql`, `wait-for-deploy.mjs`.
5. Staging resources and secrets, with your help. Create the production test account and its group. Then `staging.yml` **without** the promote job, on its schedule and the manual trigger, until it's green. In this step, also confirm:
   - the session pooler addresses connect from a GitHub runner;
   - a push to the staging repo with its deploy key publishes Pages;
   - the old-app check fails on a deliberately breaking change (e.g. rename a column in a throwaway branch);
   - a failed run opens the `staging-failed` issue and the revert PR, and the next green run closes it.
6. Turn on promote, `check-production.yml`, `rollback.yml` and the rulesets. Do one dry run of the rollback to the current production commit (which changes nothing). Update the README (*Releasing*, *Tests*, the rules in section 1) and STATUS.

## 7. Verification
- Locally: `npx playwright test --project=hermetic` passes, and `--grep @p1` runs only core.
- The PR check fails for each of: a broken split, a missing `ensureRate`, an unbumped `VERSION`, a Content-Security-Policy that doesn't match `config.js`.
- `run-sql-tests.sh` passes on the current files, and fails if one check is changed to `FAIL`, if a file has a syntax error, or if a check is deleted.
- `migrate-staging` upgrades the "before" seed data correctly, and a second apply changes nothing.
- The old-app check fails when a commit drops or renames a column the current app reads.
- A clean change pushed to `staging` deploys to staging.trips.ericdejager.com, passes, and `main` fast-forwards to the same SHA. `check-production.yml` then sees the new `sw.js` `VERSION` on https://trips.ericdejager.com and passes.
- A phone with the app installed shows the "new version" banner after that release.
- A failing change pushed to `staging` opens the issue and the revert PR, and `main` doesn't move.
- A commit that touches `supabase/` waits for your approval, then applies to production before `main` moves.
- The rollback dry run leaves production unchanged and `check-production.yml` passes.
- The scheduled runs execute every P3 test and don't promote.
- If built: `node tests/regression/select.mjs --base <sha>` on past commits picks sensible areas:
  - `1abb1b7` (tests only) → P1 + smoke + the changed specs;
  - `2eacb5f` (groups) → everything, since it changes `schema.sql`;
  - a change to `store.js` → everything.
