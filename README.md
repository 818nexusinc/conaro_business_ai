# CONARO Business AI

**Your business. Your AI workforce. More customers. More revenue. Less administration.**

An AI workforce for each business that subscribes through the CONARO marketplace in Greater Moncton: 21 specialised agents (18 working today) that qualify enquiries, price quotes, validate and confirm bookings, assign staff, run jobs, invoice, keep the books, summarise GST/HST, draft marketing and report what they achieved. Each business gets an isolated workspace, enforced by PostgreSQL row-level security.

- **Simulation first.** There are no executors yet: every message, post, payment and purchase is recorded as SIMULATED.
- **Owner in control.** Three autonomy levels; every automatic rule starts off and every money limit at $0; level-3 actions always need the owner; a single button pauses all agents.
- **Honest numbers.** Every figure is ACTUAL, ESTIMATE, FORECAST or TARGET with its source, or says why it is unavailable.
- **Separate, and connected.** Its own repository, database migrations and deployment. It does not change the marketplace's or the CONARO operating system's builds, and talks to both over the existing signed link protocol ([docs/INTEROP.md](docs/INTEROP.md)).

## Quick start

```bash
npm install
npm run check                     # typecheck + tests on embedded PostgreSQL
npm run demo -- --serve           # synthetic cleaning business, enquiry → quote → booking → job → invoice
                                  # then http://localhost:8790  (owner@demo.example.test / demo-password-123)
npm run seed:demo                 # three demo businesses with logins for every role (printed once)
```

Run it for real (simulation mode):

```bash
cp .env.example .env              # set BAI_UNSUBSCRIBE_SECRET (and DATABASE_URL for PostgreSQL)
BAI_OWNER_PASSWORD='…' npm run tenant -- --name "Sparkle Cleaning" --slug sparkle --industry residential-cleaning --plan growth --email owner@example.com --owner "Owner Name"
npm start                         # control centre + agents' cycle (long-running host)
```

On Vercel: see [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md).


## Documentation

| Document | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Audit, architecture, tenant isolation, agents, autonomy, workflows, industry packs, subscriptions, costs, phase status |
| [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md) | Deploying on Vercel: database, environment variables, the daily cron and plan limits, checks |
| [docs/INTEROP.md](docs/INTEROP.md) | How it works with the marketplace and the operating system: protocol, provider feed contract, sign-in hand-over, BOS summary, shared database |
| [docs/REFERENCE_CHECKS.md](docs/REFERENCE_CHECKS.md) | Official sources relied on (CRA GST/HST) and how they were checked |
| [CLAUDE.md](CLAUDE.md) | Working agreement for changes to this repository |
