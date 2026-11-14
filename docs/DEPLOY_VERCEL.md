# Deploying CONARO Business AI on Vercel

Project: https://vercel.com/818nexus/conaro_business_ai (connected to `818nexusinc/conaro_business_ai`).

## How it runs on Vercel

| Piece | On Vercel |
|---|---|
| Control centre and the signed link endpoints | One Vercel Function, `api/index.mjs`, which re-exports `dist/handler.mjs`. `npm run build` (the build command in `vercel.json`) bundles that file. `vercel.json` rewrites every path to the function. The bundle reads no files at runtime: the SQL migrations and the stylesheet are embedded. |
| Static files | Only `public/robots.txt` (asks search engines not to index the control centre). `outputDirectory` is `public`, so no repository file is ever served as a static file. |
| Database migrations | Applied automatically when an instance starts (serialised with a database lock). |
| The agents' cycle | No background loop: **Vercel Cron** calls `GET /api/cron/tick` (in `vercel.json`) with `Authorization: Bearer $CRON_SECRET`. A database lease stops overlapping cycles; every step is idempotent, so a repeated or missed call is safe. |
| Data | A hosted PostgreSQL in `DATABASE_URL`. The embedded database is refused on Vercel, because nothing on a function's disk persists. |

Everything stays in simulation: there are no executors, so no message, post or payment leaves the application.

## How often the agents run

Vercel's limits ([R60](REFERENCE_CHECKS.md)): **Hobby** allows cron jobs **once per day** (anywhere within the scheduled hour) and **fails the deployment** for anything more frequent. **Pro** allows once per minute.

- `vercel.json` therefore ships with one daily run at `0 11 * * *` (11:00 UTC = 07:00–08:59 in Moncton, after the 07:00 local start of daily duties). This works on every plan.
- On **Pro**, change it to `*/15 * * * *` so reminders, enquiries and bookings are handled within 15 minutes.
- On **Hobby**, you can call the same endpoint more often from any scheduler that can send the header (for example the CONARO operating system's worker, or a GitHub Actions schedule). Keep in mind that scheduled GitHub Actions count against your Actions minutes.
- Actions taken in the control centre (an enquiry entered, a job completed) are picked up at the next run.

## Set-up, step by step (owner)

1. **Database.** Create a PostgreSQL database for Business AI: a new Supabase project (as for the operating system; `ca-central-1` recommended), or a Postgres from the Vercel Marketplace (Storage tab). Use a role that may create roles, because the first migration creates `bai_tenant`; Supabase's `postgres` role can. Use the **session** connection string (port 5432). The transaction pooler also works.
2. **Environment variables** (Vercel → Settings → Environment Variables, Production):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the connection string from step 1 |
   | `BAI_UNSUBSCRIBE_SECRET` | 32+ random characters |
   | `CRON_SECRET` | 16+ random letters and digits |
   | `BAI_PUBLIC_URL` | optional; defaults to `https://` + the production domain |
   | `ANTHROPIC_API_KEY` | optional; without it replies use approved facts only and the chat shows the records |
   | `MARKETPLACE_BASE_URL`, `BAI_MARKETPLACE_LINK_SECRET`, `BAI_BOS_LINK_SECRET` | optional; the links in [INTEROP.md](INTEROP.md). The two keys must differ. |

3. **Deploy.** Push to `main`, or select **Redeploy** in Vercel. The build runs `npm run build`.
4. **Demo accounts and the first workspace.** Add `BAI_SETUP_KEY` (32+ random characters), redeploy, and open `/setup`:
   - **Create demo accounts** builds three invented businesses (cleaning on Premium, snow and lawn on Professional, plumbing on Starter). Each gets logins for owner, manager, staff, accountant and viewer, two months of history, enquiries and agent activity. The logins are shown **once**. Running it again gives new passwords without duplicating data, and **Remove demo accounts** closes them.
   - **First real business** creates a real workspace and its owner.
   - Remove `BAI_SETUP_KEY` when you are done.

   Demo workspaces show a DEMO banner and are left out of the summary the operating system reads. From a computer instead: `DATABASE_URL=… BAI_UNSUBSCRIBE_SECRET=… npm run seed:demo`. Or, to create the first workspace from a computer: From a computer with the repository: `DATABASE_URL=… BAI_UNSUBSCRIBE_SECRET=… BAI_OWNER_PASSWORD='…' npm run tenant -- --name "…" --slug … --industry … --plan … --email … --owner "…"`.
5. **Sign in** at the production address and finish onboarding in Business settings.
6. **Check the deployment:**
   - `GET /healthz` answers `{"ok":true}`.
   - `/login` shows the sign-in page.
   - Sign in, and check that the other pages load and forms submit (this confirms the rewrite passes the original path to the function, as the build output's routing table shows).
   - In Vercel → Schedules → Cron Jobs, select **Run** (or wait for the schedule). The log should show a 200 with `"ran":true`. A 401 means `CRON_SECRET` differs; redeploy after changing it.
7. **Preview deployments** use the Preview environment's variables. Give them their own database, or leave them without `DATABASE_URL` (they then show the configuration message). Vercel only runs crons on production.

If a variable is missing or wrong, every page shows the problem (names only, never values) instead of failing silently.

## If a build goes down the wrong path

| Build log shows | Cause | Fix (already in the repository) |
|---|---|---|
| `No Output Directory named "public"` | Built as a static site | `vercel.json` sets `outputDirectory: "public"` and rewrites every path to `api/index.mjs` |
| `buildah` / `container` steps, then `NAME_INVALID` when pushing an image | Vercel's **Container** preset, picked because a `Dockerfile` was at the root when the project was created | The Dockerfile is in `docker/` and `vercel.json` sets `"framework": null`, which overrides the project's preset. Optionally also set Settings → Build and Deployment → Framework Preset to **Other**. |

## Local equivalent

```bash
npx vercel@latest build --yes      # the same build Vercel runs (needs .vercel/project.json, e.g. from `vercel pull`)
```

What was verified on 14 November 2026:

- **Build:** `vercel build` (Vercel CLI 65.16.0) completed. It produced one function on `nodejs24.x` and a routing table that sends every path to it after `robots.txt`, plus the daily cron.
- **Packaged function, run by itself** against PostgreSQL 16 as a non-superuser:
  - migrations applied from the bundle;
  - `/healthz` and `/login` returned 200;
  - the cron endpoint ran a cycle.
- **The earlier `server.ts` approach failed:** Vercel built the repository as a static site (`No Output Directory named "public"`), because zero-configuration server detection only applies to the Express, Hono, H3, Koa, NestJS, Fastify and Elysia presets.

A real Vercel deployment has not been observed from this environment: confirm with step 6.
