# Reference checks

Official sources this application relies on, with the status actually achieved: **Fetched** (the page was read), **Search-confirmed** or **Not verified**. Numbering continues the CONARO operating system's list so references are unique across CONARO.

## GST/HST (fetched 14 November 2026)

| # | Source | Status | Excerpt relied on |
|---|---|---|---|
| R58 | CRA: GST/HST calculator (and rates) — www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html | Fetched 2026-11-14 (page modified 2025-04-01) | Current rates: AB 5%, BC 5% (+7% PST), MB 5% (+7% PST), NB 15%, NL 15%, NT 5%, NS 14%, NU 5%, ON 13%, QC 5% (+9.975% QST), PE 15%, SK 5% (+6% PST), YT 5%; "As of April 1, 2025, the HST rate has decreased to 14% in Nova Scotia." Used by `src/catalog/tax.ts` |
| R59 | CRA: When to register for and start charging the GST/HST — www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html | Fetched 2026-11-14 (page modified 2026-06-16) | Small supplier: "You do not exceed the $30,000 threshold over four consecutive calendar quarters"; register if not a small supplier and you make taxable supplies in Canada. Used by the `tax.registration_check` tool, which only notifies and refers to the CRA or an accountant |

## Vercel (fetched 14 November 2026)

| # | Source | Status | Excerpt relied on |
|---|---|---|---|
| R60 | Vercel: Cron Jobs usage and pricing — vercel.com/docs/cron-jobs/usage-and-pricing | Fetched 2026-11-14 (page updated 2026-07-15) | Hobby: minimum interval "Once per day", precision "Per-hour (±59 min)"; "Cron expressions that would run more frequently will fail during deployment." Pro and Enterprise: once per minute |
| R61 | Vercel: Managing Cron Jobs — vercel.com/docs/cron-jobs/manage-cron-jobs | Fetched 2026-11-14 (page updated 2026-08-11) | `CRON_SECRET` is sent as `Authorization: Bearer <value>`; use letters and digits; crons run only on production deployments; no retries; delivery is best effort and can repeat, so runs must be idempotent; concurrent runs are possible, use a lock |
| R62 | Vercel: Node.js runtime — vercel.com/docs/functions/runtimes/node-js | Fetched 2026-11-14 (page updated 2026-08-11) | Standard Node.js request/response objects; the `request.body` helper "is only computed when it is accessed" |
| R63 | Vercel changelog: Deploy Node servers with zero configuration — vercel.com/changelog/deploy-node-servers-with-zero-configuration | Fetched 2026-11-14 (post of 2026-06-23) | Mentions `server.ts` detection. **Not relied on:** in practice (Vercel CLI 65.16.0 `vercel build`), detection applies only to the backend framework presets (`express`, `hono`, `h3`, `koa`, `nestjs`, `fastify`, `elysia` in `@vercel/build-utils`), and a plain `node:http` server was built as a static site and failed |
| R64 | Vercel: Express on Vercel — vercel.com/docs/frameworks/backend/express | Fetched 2026-11-14 (page updated 2026-11-14) | Entry point candidates (`app`, `index`, `server`, also under `src/`) must import the framework package; static assets come only from `public/**` |

## CASL

The consent periods and prescribed message content follow the CONARO operating system's checked references (its `docs/REFERENCE_CHECKS.md`, CASL entries): the Act (S.C. 2010, c. 23, ss. 6 and 10) and the Electronic Commerce Protection Regulations (SOR/2012-36). Counsel should review them before any real message is sent.

## Re-checking

Re-read each Fetched page at least every 6 months and before changing the code that depends on it.
