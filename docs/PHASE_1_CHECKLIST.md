# Phase 1 Checklist — Project Setup

Status: **complete** (2026-10-26). No application features implemented.

## Setup

- [x] Folder inspected before changes. The project had already been initialized in place (no nested folder); only missing items were added.
- [x] Next.js App Router project with TypeScript, Tailwind CSS, ESLint, `src/` directory and `@/*` alias (`tsconfig.json` → `./src/*`)
- [x] Package manager: npm, lockfile `package-lock.json`
- [x] Stock root `src/app/layout.tsx` and starter `src/app/page.tsx` preserved
- [x] Scripts: `dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`; added in this phase)
- [x] No payment SDK installed (provider undecided)

## Installed versions

| Package | Version |
| --- | --- |
| next | 16.4.3 |
| react / react-dom | 19.3.0 |
| typescript | 5.9.3 |
| tailwindcss / @tailwindcss/turbopack | 4.3.3 |
| eslint / eslint-config-next | 9.39.5 / 16.4.3 |
| @types/node / @types/react / @types/react-dom | 20.19.43 / 19.3.0 / 19.3.0 |
| @supabase/supabase-js | 2.118.0 |
| @supabase/ssr | 0.12.7 |
| pdfjs-dist | 6.4.299 |
| pdf-lib | 1.17.1 |
| zod | 4.6.7 |
| lucide-react | 1.61.0 |

## Folder structure

- [x] `src/app/(auth)/login`, `src/app/(dashboard)/dashboard`, `src/app/p/[token]`
- [x] `src/app/api/proposals`, `src/app/api/payments/checkout`, `src/app/api/payments/webhook`
- [x] `src/app/api/access`: an addition to the requested list, for token-scoped client document access and recovery, kept apart from the internal endpoints
- [x] `src/components/{ui,dashboard,proposals,pdf}`
- [x] `src/lib/{supabase,auth,proposals,pdf,payments,validation}`, `src/types`
- [x] `supabase/migrations`, `docs`, `public`
- [x] Empty folders contain `.gitkeep`. There are no `page.tsx`/`route.ts` placeholders, so no routes are created

## Environment

- [x] `.env.example` lists `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` with empty values
- [x] No privileged keys (service role, payment secrets) in the template
- [x] `.gitignore` ignores `.env*` and re-includes `!.env.example`

## Verification (actual results)

| Check | Command | Result |
| --- | --- | --- |
| Clean install | `npm ci` | Passed, 0 vulnerabilities |
| Lint | `npm run lint` | Passed (exit 0, no warnings) |
| Typecheck | `npm run typecheck` | Passed (exit 0) |
| Production build | `npm run build` | Passed; routes `/` and `/_not-found` (static) |

## Blockers

None for Phase 1.

Notes:
- The folder is not a git repository yet. Run `git init` when version control is wanted. The `.gitignore` rules were checked by reading the file, not with `git check-ignore`.
- Next.js 16 renamed `middleware.ts` to `proxy.ts`; Phase 3 auth will use `src/proxy.ts`.
- The payment provider is undecided, which blocks only the real payment adapter in Phase 7 (see OPEN_QUESTIONS.md).
