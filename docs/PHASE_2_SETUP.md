# Phase 2 — Database, Auth, Roles and Private Storage

Status: **implemented and verified against a local Supabase stack** (2026-10-26). No hosted Supabase project has been configured or modified.

## 1. What Phase 2 adds

| Area | Files |
| --- | --- |
| Migrations | `supabase/migrations/20261026120000_core_schema.sql`, `…120100_rls_policies.sql`, `…120200_storage_proposals_bucket.sql` |
| Local Supabase config | `supabase/config.toml` |
| Supabase clients | `src/lib/supabase/config.ts`, `client.ts` (browser), `server.ts` (request-scoped), `proxy.ts` (session refresh) |
| Proxy | `src/proxy.ts`: refreshes the session; redirects unauthenticated `/dashboard` requests to `/login` |
| Auth helpers | `src/lib/auth/session.ts` (`getAuthState`, `getInternalUser`, `requireInternalUser`, `requireRole`), `roles.ts`, `redirect.ts`, `actions.ts` (sign out) |
| Validation | `src/lib/validation/auth.ts` |
| Login | `src/app/(auth)/login/` (page, form, server action) |
| Dashboard placeholder | `src/app/(dashboard)/dashboard/page.tsx`, `src/components/dashboard/sign-out-button.tsx` |
| Types | `src/types/database.ts` (checked against `supabase gen types`) |
| Tests | `supabase/tests/database/phase2_authorization.test.sql` (pgTAP), `supabase/tests/integration/phase2-api.mjs`, `supabase/tests/integration/phase2-app.mjs` |

New dev dependency: `supabase` (CLI, for local stack, migrations and tests). New dependency: `server-only`.

## 2. Supabase configuration

### Environment variables (`.env.local`, gitignored)

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=<project URL>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
```

- **Local stack:** run `npx supabase status` and use its `API_URL` and `PUBLISHABLE_KEY`.
- **Hosted project:** Dashboard → Project Settings → API Keys → *Publishable key*. Use the project URL from the same page.
- Phase 2 needs **no** secret or service-role key in the app. Never put one in a `NEXT_PUBLIC_*` variable. (Phase 4 adds a server-only `SUPABASE_SECRET_KEY` for four trusted proposal writes; see [PHASE_4_SUMMARY.md](PHASE_4_SUMMARY.md) §8.)
- If the variables are missing, the build still succeeds. `/login` then shows a "not configured" notice instead of a broken form.

### Auth settings

| Setting | Local (`supabase/config.toml`) | Hosted (Dashboard) |
| --- | --- | --- |
| Public signup | `[auth] enable_signup = false` | Authentication → Sign In / Providers → **Allow new users to sign up: off** |
| Email provider | `[auth.email] enable_signup = true` (this enables the email provider, so it must stay true) | Email provider **enabled** |
| Site URL | `http://localhost:3000` | Authentication → URL Configuration → Site URL (`http://localhost:3000` for dev; the real domain later) |
| Redirect URLs | `http://localhost:3000`, `http://127.0.0.1:3000` | Same list under Redirect URLs |
| Min password length | 12 | Authentication settings → password requirements → minimum length 12+ |
| Anonymous sign-ins | off | off |
| Seed data | disabled | — |

> On local Supabase, `[auth.email] enable_signup = false` turns off email **login** entirely, not just signup. This was hit and fixed during verification.

## 3. Migrations

### Local (recommended for development)

Requires Docker Desktop running.

```bash
npm run db:start     # starts local Supabase and applies all migrations
npm run db:reset     # re-applies migrations from scratch (destroys local data)
npm run db:test      # pgTAP authorization tests
npm run db:stop
```

### Hosted dev project (when you have one)

```bash
npx supabase login
npx supabase link --project-ref <dev-project-ref>
npx supabase db push --dry-run     # review what will run
npx supabase db push
```

Only push to a production project deliberately, after reviewing the dry run. Nothing was pushed during Phase 2.

## 4. Manual account provisioning (1 Admin + 5 Team Leads)

There is no signup page, account-management screen or account-creation API. Roles are never taken from user metadata, and the first user is not made admin automatically.

1. **Create the auth users.** Dashboard → Authentication → Users → *Add user* → *Create new user*. Enter the email and a strong password, and tick **Auto Confirm User**. Repeat for all six accounts. Locally, use Studio at `http://127.0.0.1:54323`.
   Deliver passwords through a secure channel. Don't store them in this repo.
2. **Assign roles** in the SQL Editor (it runs as the database owner, which is the trusted path):

   ```sql
   insert into public.profiles (id, full_name, role)
   select id, 'Jane CEO', 'admin' from auth.users where email = 'ceo@yourcompany.com';

   insert into public.profiles (id, full_name, role)
   select id, 'Lead One', 'team_lead' from auth.users where email = 'lead1@yourcompany.com';
   -- …repeat for the remaining four team leads
   ```

3. **Check the result:**

   ```sql
   select p.full_name, p.role, u.email
   from public.profiles p join auth.users u on u.id = p.id
   order by p.role, p.full_name;
   ```

4. **Change a role later** (SQL Editor only): `update public.profiles set role = 'team_lead' where id = '<uuid>';`
5. **Remove access:** delete the profile row if the user owns no records (`delete from public.profiles where id = '<uuid>';`). Without a profile the user is denied even if their Auth login still works. If they own records, the delete is blocked by design to preserve history; ban or delete the user in Authentication instead.

An auth user **without** a profile row can authenticate with Supabase, but cannot use the portal. The login action signs them back out, and `/dashboard` redirects them to `/login?error=no_access`. RLS shows them no rows.

## 5. Private bucket

The storage migration creates bucket **`proposals`**: `public = false`, PDF only (`application/pdf`), 25 MiB limit. You do not need to create it manually. On a hosted project, confirm under Storage that the bucket shows as private.

Object paths, enforced by policy and by `CHECK` constraints on `proposals`:

```
{owner_id}/{proposal_id}/original.pdf
{owner_id}/{proposal_id}/preview.pdf
```

Uploads and client delivery are not implemented yet (Phases 4–5). Client access will go through server code issuing short-lived signed URLs.

## 6. Running locally

```bash
npm install
npm run db:start                 # needs Docker Desktop
cp .env.example .env.local       # fill from `npx supabase status`
# create users + profiles as in §4 (Studio: http://127.0.0.1:54323)
npm run dev                      # http://localhost:3000/login
```

## 7. Authorization model

### Identity

- The proxy (`src/proxy.ts`) calls `supabase.auth.getClaims()` to validate and refresh the session. It is used only for the coarse `/dashboard` → `/login` redirect.
- Pages, Server Actions and Route Handlers re-check identity themselves. They call `supabase.auth.getUser()`, which validates the session with the Auth server, and then load the caller's `profiles` row through RLS. The role comes **only** from `public.profiles.role`.
- Server Actions and Route Handlers must call `getInternalUser()` and reject `null`. Pages use `requireInternalUser()` / `requireRole()`. A route guard alone is never treated as sufficient.
- Post-login redirects accept only same-origin paths (`getSafeRedirectPath`).

### Database (enforced for every API request)

| Table | `authenticated` grants | RLS rows |
| --- | --- | --- |
| `profiles` | SELECT only | own row; admin: all |
| `clients` | SELECT, DELETE; INSERT(owner_id, name, email); UPDATE(name, email) | own; admin: all |
| `proposals` | SELECT, DELETE; INSERT(client_id, owner_id, title, free_preview_pages, unlock_price_minor, currency); UPDATE(title, free_preview_pages, unlock_price_minor, currency, status) — `client_id` was updatable in Phase 2; the Phase 3 migration revoked it. **Phase 4:** INSERT/UPDATE of the offer columns and UPDATE of `status` revoked (trusted functions only); SELECT is per column, excluding `link_token_hash` | own; admin: all |
| `payments` | SELECT only | payments of own proposals; admin: all |
| storage `proposals` | via policies | object path must match an existing proposal the caller owns (admin: any proposal). Phase 4: uploads only for drafts, deletes only for objects that aren't the current original/preview, no updates |

`anon` has no grants on application tables and no storage policies.

Further guarantees:

- **Role escalation blocked.** There is no INSERT/UPDATE grant on `profiles`, and auth user/app metadata is never read.
- **Ownership is immutable through the API, for admin too.** `owner_id` is not updatable (column grants), and a trigger rejects changes from `authenticated`/`anon`. Ownership transfer would need a future trusted procedure that also moves storage objects.
- **A proposal's client must have the same owner.** This is enforced by the composite FK `(client_id, owner_id) → clients(id, owner_id)`.
- **Server-controlled columns.** `original_storage_path`, `preview_storage_path`, `total_pages`, `created_at`, `updated_at` and `id` cannot be written by browser roles. Timestamps are always set by triggers.
- **Payments are read-only for every browser user**, admin included. Writes are reserved for trusted server code in Phase 6.
- **`private.is_admin()`** is `SECURITY DEFINER` with `search_path = ''`. It lives in the non-exposed `private` schema and only `authenticated` can execute it. It reads `profiles` without re-entering profiles RLS, so there is no recursion.

### Deletion behaviour

| Relationship | On delete |
| --- | --- |
| `auth.users` → `profiles` | CASCADE |
| `profiles` → `clients`, `proposals` | RESTRICT (an account that owns records can't be deleted) |
| `clients` → `proposals` | RESTRICT (archive instead) |
| `proposals` → `payments` | RESTRICT (payment history is never cascaded away) |

Deleting a draft proposal row does not yet delete its storage objects. Phase 4 must remove objects when it deletes proposals.

## 8. Verification results (2026-10-26, local Supabase via Docker)

| Check | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | ✅ pass |
| Typecheck | `npm run typecheck` | ✅ pass |
| Production build | `npm run build` | ✅ pass (`/login`, `/dashboard` partially prerendered; proxy active). Also builds with no env vars |
| Migrations apply cleanly | `npm run db:start` | ✅ 3/3 applied |
| DB authorization (pgTAP, real `authenticated`/`anon` roles + JWT claims) | `npm run db:test` | ✅ **72/72** |
| API authorization (real Auth sign-in, PostgREST, Storage API) | `npm run test:integration` | ✅ **34/34** |
| App auth flows (production server + real sessions; login/logout forms submitted as server actions) | `npm run test:app` | ✅ **17/17** |

Covered:
- Unauthenticated visitors and forged cookies are redirected away from `/dashboard`.
- The login form gives the same generic error for a wrong password and an unknown email.
- A valid login without a profile is rejected and signed out. A valid internal login reaches `/dashboard` with name and role.
- Sign out clears the cookie and revokes the session (the old cookie stops working).
- Authenticated users are redirected away from `/login`, and an external `next=` is ignored.
- Lead A cannot read, update, delete or reassign lead B's records, cannot attach a proposal to B's client, and cannot promote themselves via a profile update or metadata.
- Admin reads and manages across leads, but can't write payments or change roles via the API.
- Anon has no table or storage access, and the bucket has no public URL access.
- Lead A cannot download, list, sign, upload to or delete lead B's PDF objects. A path prefix with a foreign or non-existent proposal id is rejected.
- No browser user can insert, update or delete payments.
- Public signup is rejected by Supabase Auth.
- All test data was disposable: pgTAP rolls back, and the integration scripts delete their users and objects.
- The local secret key was used only to provision and clean up fixtures, never for isolation checks.

Not verified:
- **Visual browser rendering of `/login` and `/dashboard`.** The Chrome extension wasn't connected, so the forms were exercised over HTTP as no-JS submissions. The client-side loading state was not observed in a real browser.
- **Hosted Supabase project settings.** None was configured. Apply §2 and §4 when one exists.

## 9. Remaining blockers / follow-ups

- **No hosted dev project yet.** Create one, apply the settings in §2, push migrations (§3), then provision the six accounts (§4).
- **Deactivation.** There is no `is_active` flag (not in the Phase 2 schema). Access is removed by deleting the profile (only if the user owns no records) or by banning the user in Auth. Revisit if needed.
- **Currency allow-list.** The DB enforces the `^[A-Z]{3}$` format. The exact list of allowed ISO 4217 codes will be enforced with Zod in Phase 3, once the currency question in OPEN_QUESTIONS is answered.
- **Storage cleanup on proposal delete:** still open after Phase 4. There is no delete UI. See PHASE_4_SUMMARY §11.
