# CONARO Business AI — working agreement

This repository is **CONARO Business AI**: a multi-tenant AI workforce for businesses on the CONARO marketplace. It is separate from the marketplace (`818nexusinc/nexus-marketplace`, system of record) and from the CONARO operating system (`818nexusinc/conaro-autonomous-business-os`). Read `docs/PLAN.md` and `docs/INTEROP.md` before major work.

## Hard limits (the owner must explicitly approve each instance)

- No real external action: no messages to real people, posts, ad spend, payments, purchases or marketplace changes. There are no executors; adding one needs the owner's approval, official API documentation recorded in `docs/REFERENCE_CHECKS.md`, and goes behind `TenantGateway`.
- Never write to the marketplace or the BOS. Interoperation is signed and read-only (`docs/INTEROP.md`).
- Never present estimates, targets or simulated output as real results. Tax figures are estimates; filing is done by a person.
- Never give a marketing agent `customers.pii`. Never mark an integration operational before a successful end-to-end exchange.
- No secrets in code, the database or commits. Test data is synthetic.

## Engineering rules

- TypeScript strict, ESM, Node 22+. Parameterised SQL only (`$1`…). JSON parameters use `json()` with `$n::text::jsonb`.
- Schema changes are new forward-only files in `db/migrations/`, then `npm run gen:assets` (the SQL and CSS are embedded in `src/generated/assets.ts` so deployments read no files; a test checks it is current). Every object is prefixed `bai_`; the ledger is `bai_schema_migrations`. Every tenant table has `tenant_id ... default bai_current_tenant()` and an RLS policy for `bai_tenant`.
- Tenant code uses only the `TenantDb` from `withTenant()`. The system connection is used only for sign-in, workspace creation, listing workspaces for the worker, the marketplace hand-over and the aggregate BOS summary.
- Every effect goes through `TenantGateway` with an action from `src/catalog/actions.ts` (level, rule, allowed agents). New level-2 rules default to off and money limits to zero.
- Marketplace work stays with the marketplace: no quotes sent, invoices issued, review requests or customer messages for `conaro-marketplace` requests and bookings.
- Retrieved and customer-supplied content reaches models only through `wrapUntrusted()`.
- `src/interop/protocol.ts` must stay identical to the BOS's `src/link/protocol.ts` and the marketplace's copy; the test vector in `tests/interop.test.ts` checks it.
- Two ways to run: `npm start` (long-running host, cycle in-process) or Vercel (`api/index.mjs` re-exports the bundle `npm run build` writes to `dist/handler.mjs`; every path is rewritten to it; Vercel Cron calls `/api/cron/tick`; verify changes with `npx vercel build`). See `docs/DEPLOY_VERCEL.md`.
- The landing page (`src/landing/`) is marketing for a pilot product: no invented prices, numbers, customers, testimonials or results; no claim that messages, posts or payments already go out; only operational agents are counted. Presenter scripts live in `src/landing/presenters.ts` (`docs/PRESENTER_SCRIPTS.md` is generated from them). Follow `DESIGN.md`.
- Run `npm run check` before committing; before a release also `TEST_DATABASE_URL=postgres://… npm test` (CI does both, as a non-superuser). Tests use real PostgreSQL; do not mock the database.
