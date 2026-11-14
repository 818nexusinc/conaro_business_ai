# CONARO Business AI — audit, architecture and implementation plan

_14 November 2026. Status of each item is in §10; nothing here is described as working unless a test or the demo exercises it._

CONARO Business AI gives each business that subscribes through CONARO its own coordinated AI workforce. It is a **separate application in its own repository**, with its own database migrations and deployment, so it does not affect the builds of the marketplace (`818nexusinc/nexus-marketplace`, the system of record) or of the CONARO operating system (`818nexusinc/conaro-autonomous-business-os`, the BOS). It interoperates with both over the signed link protocol: see [INTEROP.md](INTEROP.md).

**What runs today (simulation):** onboarding and the Business Intelligence Profile; 18 working agents with 49 tools; the event and schedule engine with the brief's five §6 scenarios plus hourly, daily, weekly and monthly duties; the three-level autonomy framework with approvals and a kill switch; CASL consent per business; bookkeeping, GST/HST and financial reporting with every figure labelled; the growth command centre, daily executive summary and monthly AI value report; subscriptions with entitlements and metering; and the owner control centre. `npm run demo` runs enquiry → quote → booking → job → invoice end to end.

**What does not exist yet:** any real external effect. There are **no executors**: every message, post, payment and purchase is recorded as SIMULATED. No calendar, email, social, Stripe or accounting integration is connected. The marketplace feed and sign-in hand-over are built and tested against a simulated marketplace; the marketplace still has to add its side (INTEROP.md §2–3). Billing is not connected and plan prices are not set.

---

## 1. Audit (brief §16, items 1–10)

| # | Item | Finding |
|---|---|---|
| 1 | Existing repository | This repository is CONARO's own Business Operating System (BOS): one business (CONARO), 15 staff agents, task queue, ActionGateway, approvals, hash-chained audit, CASL ledger, dashboard, QA and security agents; 200 tests passing before this work. It is single-tenant by design (`agents`, `tasks`, `approval_requests` have no tenant). |
| 2 | Marketplace architecture | From the BOS repository's `docs/EXISTING_PLATFORM_AUDIT.md`: Next.js 16 on Vercel, PostgreSQL on Supabase, 56 tables. Providers already have a dashboard with leads, jobs, bookings, schedule, clients, earnings, team and timesheets. |
| 3 | Stack | TypeScript (strict, ESM), Node 22, PostgreSQL (Supabase in production, PGlite in tests), postgres.js, Zod 4, Anthropic SDK, server-rendered HTML with no client JavaScript. Business AI uses the same stack: no new runtime dependency was added. |
| 4 | Authentication and database | Marketplace: custom scrypt sessions (not Supabase Auth). BOS: separate operator accounts with TOTP. Business AI adds its own business-user accounts (`bai_users`, scrypt via the BOS's `hashPassword`) because business owners are not CONARO operators. Single sign-on from the marketplace is the intended next step (§9). |
| 5 | Booking and payment capabilities | The marketplace has requests, quotes, bookings, reviews and Stripe Connect Express payouts to providers. Business AI does **not** duplicate payment processing: it records invoices and payments the business reports, and payment providers stay behind a future, owner-approved integration. |
| 6 | Available APIs | The marketplace has no general API: writes are Server Actions behind browser sessions. The only machine path is the signed, read-only BOS link (the BOS's `docs/MARKETPLACE_LINK.md`), which carries aggregates for CONARO, not one provider's private data. |
| 7 | Integration limitations | (a) No per-provider feed of marketplace requests and bookings yet, so marketplace enquiries are entered or will arrive through a new signed endpoint (§9). (b) No calendar, email, SMS, social, accounting or payment connection exists for any business. (c) Every third-party API must be verified against its documentation (CLAUDE.md) before an executor is written. |
| 8 | Technical architecture | §2–§7 below. |
| 9 | Phased plan | §10. |
| 10 | Recurring costs | §8. |

**Overlap decision.** The marketplace's provider dashboard already shows clients, schedule and earnings. Business AI adds what the dashboard does not have — qualification, pricing rules, availability validation, workflow automation with approvals, bookkeeping, tax summaries, reporting and the agents — and is meant to read marketplace requests and bookings rather than replace them once the per-provider feed exists.

## 2. Architecture

```
 marketplace (system of record) ── signed per-provider feed (planned) ──┐
                                                                       ▼
 owner control centre (portal) ──► withTenant(tenant) ──► tenant tools ──► TenantGateway ──► effects on the business's own records
   sessions bound to one tenant      SET LOCAL ROLE bai_tenant        (scope-checked)      level 1/2/3, rules,        + SIMULATED external effect
                                     bai.tenant_id = <uuid>                                approvals, CASL, kill switch
                                     RLS on every bai_* table                                         │
 worker cycle (runCycle) ─► for each tenant: schedule → events → workflow runs → steps ───────────────┘
                                                                       │
                                                       ReasoningPort (Claude, or the honest simulation)
```

### 2.1 Tenant isolation, layer by layer

| Layer | Control | Proof |
|---|---|---|
| Database | Every tenant table has `tenant_id` defaulting to `bai_current_tenant()` and an RLS policy for the role `bai_tenant` (no BYPASSRLS). Tenant code runs as that role inside a transaction with `bai.tenant_id` set. No tenant set → no rows. | `tests/business-ai.test.ts` "tenant isolation": reads, writes, updates and audit across tenants all fail |
| Application | Tenant code only receives a `TenantDb` from `withTenant()`; it refuses `SET ROLE`, `RESET ROLE`, `set_config` and tenant switching. | same file, "tenant code cannot change role or switch tenant" |
| API / portal | The session is bound to one tenant at sign-in; the tenant is never taken from the URL or form; membership and role are re-read on every request. | `tests/business-ai-portal.test.ts`: another business cannot see or approve |
| Background jobs | The worker lists tenant ids, then runs each tenant's schedules, events and steps in that tenant's own transactions; one tenant's failure does not stop the others. | `businessAiCycle()` |
| Agents | A tool runs as one agent of one tenant; scopes are checked before it runs; marketing agents never hold `customers.pii`. | `tests/business-ai-catalog.test.ts` |
| Storage | Documents are stored as text in `bai_documents` under the same RLS; no shared file bucket yet. | — |
| Audit | One SHA-256 hash chain per tenant (`bai_audit`, append-only). | chain verified in tests and on the Audit page |

**Residual risk, stated plainly:** `bai_tenant` is entered with `SET LOCAL ROLE` from the application's connection, so code that bypassed `TenantDb` and ran raw SQL on the system connection could reach every tenant. For production, run tenant work through a separate login role that is a member of `bai_tenant` only (a Supabase role created by the owner), so even that mistake cannot reach other tenants.

### 2.2 Modules (`src/`)

| Path | Purpose |
|---|---|
| `tenancy.ts` | `withTenant()`, `TenantDb`, references |
| `catalog/agents.ts`, `actions.ts`, `industries.ts`, `plans.ts`, `tax.ts` | The 21 agents, action levels, 25 industry packs, plans and entitlements, GST/HST rates (CRA, R58–R59) |
| `profile.ts` | Onboarding schema, versioned profile, Business Intelligence Profile |
| `tenants.ts` | Workspace creation, members, agents, plans, services, team, kill switch |
| `gateway.ts`, `effects.ts` | The only path to any effect; record changes applied on execution |
| `settings.ts`, `consent.ts`, `usage.ts`, `audit.ts` | Operating rules, CASL per business, metering, per-tenant audit |
| `agent-context.ts`, `tools/` | Agent runtime and the 49 tools |
| `events.ts`, `workflows.ts` | Events, workflow definitions, engine, scheduler, cycle |
| `portal/` | Owner control centre |
| `interop/` | Link protocol (shared with the BOS and marketplace), marketplace provider feed, sign-in hand-over, BOS summary |
| `shared/` | Database driver and migrations, reasoning port, HTML, passwords, CASL message rules (copied from the BOS so this repository builds on its own) |

## 3. The workforce

18 of the 21 agents are **operational** (tools, tests, observable output). Three are **planned** and cannot be switched on or billed: Inventory and Procurement (14), Business Development (17) and Competitor Intelligence (19).

| # | Agent | Tools (what it actually does) |
|---|---|---|
| 1 | Business Manager | daily executive summary; capacity review (starts the unused-capacity workflow); revenue vs target (starts the corrective workflow and writes the plan); weekly and monthly reports; chat from records |
| 2 | Marketing Director | monthly seasonal and repeat-customer campaign drafts from the industry pack (no spend); capacity campaigns with discounts capped by the owner's rule |
| 3 | Social Media Manager | content calendar (two posts a week per campaign, from real services); publishing only to connected accounts, through approval or the autopublish rule |
| 4 | Local SEO | profile and service checks; FAQ drafts answered from the business's own facts |
| 5 | Sales | rule-based lead scoring with a reason per criterion; CASL-checked quote follow-ups; lost-reason analysis |
| 6 | CRM | opportunity records; inactive-customer detection; thank-you and recurring-service opportunities |
| 7 | Booking | availability validation (duration, hours, lead time, season, skill, staff windows, conflicts, travel buffer) with alternatives; confirmation (re-validated at the moment of confirming); reminders; nearby-job grouping |
| 8 | Quotation | quotes from approved prices, minimum charge, travel fee, capped discount and GST/HST; acceptance review |
| 9 | Accounting | CSV import with duplicate and unusual-amount flags; category suggestions (the owner confirms; every change is kept); P&L; accountant export |
| 10 | Tax | GST/HST collected and paid, labelled ESTIMATE, with missing documents; small-supplier threshold check |
| 11 | Invoicing | invoices from the accepted quote; payment matching; overdue reminders |
| 12 | Workforce | assignment by skill, window and lightest load; utilisation and unused capacity |
| 13 | Operations | jobs with checklists from the industry pack; completion; delay detection |
| 15 | Customer Service | replies from approved facts only (Claude when configured, wrapped as untrusted data), escalation; booking confirmations only after confirmation |
| 16 | Reputation | genuine feedback requests; low-rating detection with private draft replies; recurring complaint words |
| 18 | Financial Analyst | financial command centre; revenue per booked hour by service; 30-day cash-flow FORECAST |
| 20 | Administrative Assistant | text documents (flagging embedded instructions), search, deadline reminders |
| 21 | Growth Analyst | growth command centre; baseline month; monthly AI value report |

The AI model is used only where language is needed (customer replies, the manager chat). Scoring, pricing, scheduling, bookkeeping and reporting are deterministic code, which keeps costs low and results reproducible.

## 4. Autonomy and permissions (brief §11)

| Level | Examples | Behaviour |
|---|---|---|
| 1 | reports, drafts, lead scoring, draft quotes and invoices, category suggestions, reminders, routine replies | Internal effects run. External ones run when the agent is set to "within my rules"; "ask first" files an approval; "draft only" sends nothing. |
| 2 | confirm bookings, send quotes, discounts, marketing, follow-ups, feedback requests, issue invoices, payment reminders, supplies, refunds | Run only when the owner's rule is on **and** the payload is inside its limit; otherwise an approval request explains why. All rules are off and all money limits are $0 at sign-up. |
| 3 | pricing changes, large purchases, ad spend, large refunds, public review replies, data disclosure; bank transfers, payout or banking changes, tax filing, legal agreements, employment decisions | Always the owner (managers cannot approve). The last group is **person-only**: approval records the decision; the system never performs it. |

Also enforced: idempotency per action key, plan entitlement, monthly usage limits, CASL consent per recipient with required message content, and **Pause all agents** (blocks every action and holds every workflow until the owner resumes).

## 5. Workflows (brief §6)

| Trigger | Steps |
|---|---|
| Service request | Sales qualifies → Quotation prices and sends within rules → Booking checks the requested time → Customer Service replies → CRM records → report to the Business Manager |
| Quote accepted | Booking validates and confirms (rule or approval) |
| Booking confirmed | Workforce assigns → Operations creates the job → Customer Service confirms to the customer |
| Job completed | Invoicing prepares and issues → CRM follows up → Reputation requests feedback |
| Unused capacity (≥ 25 % free over 14 days) | Marketing drafts a capacity campaign (discount capped) → Sales follows up open quotes |
| Revenue behind pro-rated target (from day 7) | Finance → Marketing plan → lost reasons → utilisation → Business Manager's corrective plan |
| Hourly / daily (07:00 local) / weekly (Monday) / monthly (1st) | reminders; overdue invoices, delays, deadlines, capacity, revenue, daily summary; follow-ups, bookkeeping, feedback, routes, pricing review, profitability, weekly report; campaigns, content calendar, SEO, reactivation, tax registration check, baseline, value report, monthly report |

Every step commits on its own, is recorded with its output, and hands off to the next agent through `bai_agent_messages`. Retryable failures back off (30 s doubling, five attempts); permanent ones stop the run and raise an issue for the owner. Events and runs are deduplicated per tenant.

## 6. Industry packs (brief §5)

25 packs (`catalog/industries.ts`) configure relevant agents, common enquiries, booking information, what drives duration and price, workflow flags (recurring, emergency, weather-aware, season, equipment, vehicle capacity, mobile, qualified staff), job checklists, safety, regulatory items to confirm, seasonal marketing themes and KPIs. Packs never supply numbers: durations and prices come only from the business's own services. Regulatory items are phrased as things to confirm with the relevant authority, not legal statements. Weather-aware packs say plainly that no weather service is connected.

## 7. Subscriptions (brief §13)

Starter, Growth, Professional and Premium, each including the one below. **Prices are null** until operating costs and demand are validated. Only operational agents count towards what a plan bills; planned agents are shown as "planned". Downgrading switches off agents the new plan does not cover. Usage (AI calls, external actions, workflow runs) is metered per month; AI calls and external actions stop at the plan's provisional limit. Billing is not connected, so a plan change is recorded but nothing is charged.

## 8. Recurring costs

| Cost | Driver | What we know today |
|---|---|---|
| Hosting | One more service (this app, `npm start`) and either its own database (recommended) or the BOS's database (§5 of INTEROP.md) | Business AI adds rows, not servers. Re-measure database size and cycle time with 50+ pilot businesses. |
| AI | One call per enquiry reply and one per manager chat message; everything else is deterministic | Monthly cost per business ≈ (enquiries + chat messages) × tokens per call × the model's per-token price. Tokens are recorded per call in `bai_ai_usage`; prices are **not** hard-coded — take them from Anthropic's pricing page and measure real token counts in the pilot before setting plan prices. |
| Email, SMS, social, payments | Per message / per transaction, billed by each provider | Not incurred yet (no executors). Each becomes a separate, disclosed cost when connected. |
| People | Owner approvals, support, counsel review of CASL and privacy wording | Not estimated here. |

## 9. Next steps, in order

1. **Pilot in simulation** with two or three consenting businesses: measure token use, cycle time and which approvals owners actually want automated.
2. **Marketplace side of the link:** add `GET /api/bai/v1/provider-feed` and the "Open Business AI" button to the marketplace as specified in INTEROP.md. Business AI's side is built and tested. Needs a marketplace change and the owner's approval.
3. **First executor — email** (transactional first, then consented marketing), behind `TenantGateway`, with the owner's activation per business.
4. **Calendar** (Google, Microsoft) for availability and booking sync; **Stripe** read-only payment matching; **QuickBooks/Xero** read-only import. Each needs documentation verification, OAuth per business, error handling and end-to-end tests before it is shown as operational.
5. Phase 4–5 agents: Inventory and Procurement, Business Development, Competitor Intelligence; multi-location; supplier bills (accounts payable); job costing (gross profit).
6. Before any real customer message: counsel review of the CASL bases and message templates, the privacy notice for business customers' data (PIPEDA), and retention periods.

## 10. Phase status

| Phase | Item | Status |
|---|---|---|
| 1 Foundation | Multi-tenant schema with database-enforced isolation; onboarding; BIP; orchestration; Business Manager; subscriptions and entitlements; control centre; per-tenant audit | ✅ built and tested (simulation) |
| 2 Revenue | Marketing Director, Social, Local SEO, Sales, CRM, Customer Service, Quotation | ✅ built; social publishing, analytics and SEO data ⛔ need integrations |
| 3 Operations | Booking and scheduling, jobs, workforce, invoicing, payment tracking, administrative assistant | ✅ built; calendar sync ⛔ integration |
| 4 Financial | Accounting, tax assistance, profitability, cash-flow forecast | ✅ built (CSV import); bank and accounting feeds ⛔; inventory and procurement 🔜 planned |
| 5 Advanced | Competitor intelligence, business development, advanced campaign optimisation, multi-location | 🔜 planned; industry packs ✅ |
| All | Any real external effect | ⛔ none by design until the owner approves an executor per integration |

## 11. Running it

```bash
npm install
npm run check                   # typecheck + tests (PGlite); TEST_DATABASE_URL=postgres://… npm test on a server
npm run demo -- --serve         # synthetic business, end-to-end run, control centre on :8790
BAI_OWNER_PASSWORD=… npm run tenant -- --name "…" --slug … --industry residential-cleaning --plan growth --email … --owner "…"
npm run link-provider -- --slug … --provider <marketplace provider id>
npm start                       # control centre + the agents' cycle for every business
```

Configuration is in `.env.example`; only `BAI_UNSUBSCRIBE_SECRET` is required.
