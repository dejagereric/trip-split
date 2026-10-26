# Trip Split: where we left off

_Last updated: October 25, 2026_

## Done

- **App** (this repo, `main`): trips, people (name / phone / email, contact picker), add / edit expenses with receipt scan, ledger with Spent / Benefitted filter, settle up with Text / Email, email-code sign-in, Access screen (give access, invite, remove, sign out).
- **Hosting:** GitHub Pages is on, live at https://dejagereric.github.io/trip-split/
- **Supabase project** `trip-split` (ref `pmutzpswuqvrtkdqplgs`):
  - Schema applied (migrations `email_signin_groups`, `move_access_helpers_to_private_schema`). Matches `supabase/schema.sql`.
  - Access rules tested in the live database (owner, outsider, member, signed-out), and no test data was left.
  - Security advisor: only `create_group` is flagged, and that's intentional.
  - Edge function `extract-receipt` deployed (`verify_jwt: false`; it checks sign-in and membership itself).
  - `ANTHROPIC_API_KEY` secret set (by Eric).
  - Custom SMTP set up (Gmail), and the Magic Link and Confirm signup templates now send `{{ .Token }}` codes.
- `js/config.js` has the project URL and publishable key.

## Next: custom domain `trips.ericdejager.com`

Do these in order (the DNS record must exist before GitHub switches addresses):

1. [ ] DNS at ericdejager.com's DNS host: `CNAME` record, name `trips`, target `dejagereric.github.io` (on Cloudflare, set it to "DNS only" / grey cloud).
2. [ ] Wait for DNS to take effect (minutes, up to an hour).
3. [ ] GitHub repo → Settings → Pages → Custom domain: `trips.ericdejager.com` → Save. GitHub adds a `CNAME` file to the repo.
4. [ ] Tick **Enforce HTTPS** once the certificate is ready.
5. [ ] Optional: verify ericdejager.com under GitHub account → Settings → Pages (a TXT record).
6. [ ] Claude: confirm the site answers at the new address, and update the README's address.

## Then: first real run

1. [ ] Open https://trips.ericdejager.com on a phone, sign in with the emailed code, create the group.
2. [ ] Add to the home screen, then sign in again inside the installed app (iPhone keeps it separate from Safari).
3. [ ] Create a trip, scan a real receipt, save an expense.
4. [ ] Access → Give access to one companion → Invite. Have them sign in and confirm they see the trip.
5. [ ] If anything fails, Claude checks the auth, database and function logs through the Supabase connector.

## Later / optional

- Update the design canvas (Claude Design artifact) to match the current app.
- In Supabase → Authentication → URL Configuration, set Site URL to `https://trips.ericdejager.com`. (Not needed for code sign-in.)
