import { randomBytes } from "node:crypto";
import { json, one } from "../shared/db.ts";
import { UNTRUSTED_DATA_POLICY, wrapUntrusted } from "../shared/untrusted.ts";
import type { TenantDb } from "../tenancy.ts";
import type { AgentContext } from "../agent-context.ts";
import { meter } from "../usage.ts";
import { addDays, localParts, money, plural, zonedTime } from "../time.ts";
import { tool } from "./registry.ts";
import { utilisation } from "./operations.ts";
import { financialCommandCentre, type Figure } from "./finance.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function connected(tdb: TenantDb, providers: string[]): Promise<string[]> {
  const rows = await tdb.query<{ provider: string }>("select provider from bai_integrations where status = 'operational' and provider = any($1::text[])", [providers]);
  return rows.map((r) => r.provider);
}

// ---------------------------------------------------------------- marketing director

async function draftCampaign(ctx: AgentContext, c: { name: string; kind: string; channel: string; dedupeKey: string; startsOn: string; endsOn: string; content: Record<string, unknown> }) {
  const out = await ctx.act({ actionType: "campaign.draft", title: `Draft campaign: ${c.name}`, payload: { dedupeKey: c.dedupeKey }, idempotencyKey: `campaign:${c.dedupeKey}` });
  if (out.status !== "done") return null;
  const code = `c${randomBytes(4).toString("hex")}`;
  const rows = await ctx.tdb.query<{ id: string }>(
    `insert into bai_campaigns (name, kind, channel, starts_on, ends_on, content, tracking_code, dedupe_key, created_by)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9) on conflict (tenant_id, dedupe_key) do nothing returning id`,
    [c.name, c.kind, c.channel, c.startsOn, c.endsOn, json(c.content), code, c.dedupeKey, `agent:${ctx.agent.id}`]);
  return rows[0] ? { id: rows[0].id, trackingCode: code } : null;
}

tool({
  name: "marketing.plan_month", agent: "marketing-director", scopes: ["profile", "services", "campaigns"],
  description: "Draft next month's campaigns from the industry pack's seasonal themes and in-season services. Drafts only; no spend.",
  async run(ctx, input: { month?: string }) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const month = input.month ?? addDays(`${today.slice(0, 7)}-01`, 32).slice(0, 7);
    const m = Number(month.slice(5, 7));
    const services = await ctx.tdb.query<{ name: string; seasonal_months: number[]; price_cents: number | null }>("select name, seasonal_months, price_cents from bai_services where active");
    const inSeason = services.filter((s) => s.seasonal_months.length === 0 || s.seasonal_months.includes(m));
    if (inSeason.length === 0) return { month, drafted: [], note: "No active service is in season that month; nothing to promote." };
    const themes = ctx.pack.marketing.filter((t) => t.months.length === 0 || t.months.includes(m));
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), m, 0)).toISOString().slice(0, 10);
    const drafted = [];
    for (const t of themes.length ? themes : [{ theme: `${MONTHS[m - 1]} bookings`, months: [] }]) {
      const c = await draftCampaign(ctx, {
        name: `${t.theme} (${MONTHS[m - 1]})`, kind: "seasonal", channel: "social", dedupeKey: `seasonal:${month}:${t.theme}`, startsOn: `${month}-01`, endsOn: lastDay,
        content: { theme: t.theme, services: inSeason.map((s) => s.name), audience: ctx.profile.objectives.preferredCustomers ?? "local customers in your service areas",
          areas: ctx.profile.identity.serviceAreas ?? [], budgetCents: 0, note: "No paid budget: advertising spend always needs the owner's approval." },
      });
      if (c) drafted.push({ theme: t.theme, ...c });
    }
    const repeat = await draftCampaign(ctx, { name: `Repeat customers (${MONTHS[m - 1]})`, kind: "repeat", channel: "email", dedupeKey: `repeat:${month}`, startsOn: `${month}-01`, endsOn: lastDay,
      content: { services: inSeason.map((s) => s.name), audience: "past customers with valid consent only (selected by the CRM agent)" } });
    if (repeat) drafted.push({ theme: "repeat customers", ...repeat });
    return { month, drafted, budget: ctx.policy.monthly_marketing_budget_cents ? money(ctx.policy.monthly_marketing_budget_cents) : "no marketing budget set" };
  },
});

tool({
  name: "marketing.capacity_campaign", agent: "marketing-director", scopes: ["services", "campaigns", "operations.aggregate"],
  description: "When the next 14 days have unused capacity, draft a short campaign for in-season services, with a discount only inside the owner's maximum.",
  async run(ctx, input: { unusedMinutes: number; availableMinutes: number }) {
    if (!input.availableMinutes || input.unusedMinutes / input.availableMinutes < 0.25) return { drafted: false, reason: "less than 25% of the next 14 days is free" };
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const m = Number(today.slice(5, 7));
    const services = (await ctx.tdb.query<{ name: string; seasonal_months: number[] }>("select name, seasonal_months from bai_services where active"))
      .filter((s) => s.seasonal_months.length === 0 || s.seasonal_months.includes(m));
    const discount = ctx.policy.max_discount_pct;
    const c = await draftCampaign(ctx, { name: `Open dates in the next two weeks`, kind: "capacity", channel: "social", dedupeKey: `capacity:${today.slice(0, 8)}${Number(today.slice(8)) <= 14 ? "a" : "b"}`,
      startsOn: today, endsOn: addDays(today, 14),
      content: { services: services.map((s) => s.name), freeHours: Math.round(input.unusedMinutes / 60), discountPct: discount || null,
        pricingCheck: discount ? `Discount limited to the owner's maximum of ${discount}%` : "No discount: the owner has not allowed any" } });
    return { drafted: Boolean(c), campaign: c, discountPct: discount || null };
  },
});

// ---------------------------------------------------------------- social media manager

tool({
  name: "social.content_calendar", agent: "social-media-manager", scopes: ["profile", "services", "campaigns"],
  description: "Two posts a week per draft campaign for the month, written from real services only. Publishing needs a connected account and approval (or the autopublish rule).",
  async run(ctx, input: { month?: string }) {
    const month = input.month ?? localParts(ctx.now, ctx.tenant.time_zone).date.slice(0, 7);
    const campaigns = await ctx.tdb.query<{ id: string; name: string; tracking_code: string; content: { services?: string[]; theme?: string } }>(
      "select id, name, tracking_code, content from bai_campaigns where channel = 'social' and status in ('draft','scheduled') and to_char(starts_on, 'YYYY-MM') <= $1 and to_char(ends_on, 'YYYY-MM') >= $1", [month]);
    const platforms = await connected(ctx.tdb, ["facebook", "instagram", "linkedin", "tiktok"]);
    const posts = [];
    for (const c of campaigns) {
      for (let week = 0; week < 4; week++) {
        for (const day of [1, 4]) {
          const date = addDays(`${month}-01`, week * 7 + day);
          if (date.slice(0, 7) !== month) continue;
          const service = c.content.services?.[(week + day) % Math.max(1, c.content.services.length)] ?? ctx.tenant.name;
          const text = `${c.content.theme ?? c.name}: ${ctx.tenant.name} offers ${service}${ctx.profile.identity.serviceAreas?.length ? ` in ${ctx.profile.identity.serviceAreas.slice(0, 3).join(", ")}` : ""}. Request a quote on CONARO.`;
          const key = `post:${c.id}:${date}`;
          const out = await ctx.act({ actionType: "content.draft", title: `Draft post ${date}`, payload: { campaignId: c.id, date, text }, idempotencyKey: key });
          if (out.status !== "done") continue;
          posts.push({ date, campaign: c.name, text, link: `?c=${c.tracking_code}`, imageBrief: `Photo of a real ${service} job by ${ctx.tenant.name} (owner's own photo, with the client's permission).` });
          for (const p of platforms) {
            await ctx.act({ actionType: "social.publish", title: `Publish ${date} on ${p}`, idempotencyKey: `${key}:${p}`, payload: { platform: p, campaignId: c.id, scheduledFor: date, text } });
          }
        }
      }
    }
    return { month, posts, platformsConnected: platforms, note: platforms.length ? undefined : "No social account is connected: posts are drafts only." };
  },
});

// ---------------------------------------------------------------- local SEO

tool({
  name: "seo.profile_audit", agent: "local-seo", scopes: ["profile", "services"],
  description: "Check the business profile and services for missing local information; draft FAQ answers from the business's own facts.",
  async run(ctx) {
    const findings: string[] = [];
    const desc = ctx.profile.identity.description ?? "";
    if (desc.length < 150) findings.push("Business description is shorter than 150 characters; say what you do, where, and for whom.");
    if (!ctx.profile.identity.serviceAreas?.length) findings.push("No service areas listed; customers search by community.");
    const services = await ctx.tdb.query<{ name: string; description: string; price_cents: number | null; pricing_unit: string }>("select name, description, price_cents, pricing_unit from bai_services where active");
    for (const s of services.filter((x) => x.description.length < 80)) findings.push(`Service "${s.name}" needs a description of what is included.`);
    const faq = ctx.pack.enquiries.map((q) => {
      let a: string | null = null;
      if (/how much|price|charge|cost|rates/i.test(q)) {
        const priced = services.filter((s) => s.price_cents !== null);
        a = priced.length ? priced.map((s) => `${s.name}: from ${money(s.price_cents)}${s.pricing_unit === "hourly" ? " per hour" : ""}`).join("; ") + ". Final price depends on the job." : null;
      } else if (/area|where/i.test(q) && ctx.profile.identity.serviceAreas?.length) a = `We serve ${ctx.profile.identity.serviceAreas.join(", ")}.`;
      else if (/cancel/i.test(q) && ctx.profile.operations.cancellationPolicy) a = ctx.profile.operations.cancellationPolicy;
      return { question: q, answer: a ?? "(the owner needs to answer this)" };
    });
    await ctx.act({ actionType: "content.draft", title: "Draft FAQ", payload: { faq }, idempotencyKey: `faq:${ctx.now.toISOString().slice(0, 7)}` });
    await ctx.remember("faq_draft", faq);
    for (const [i, f] of findings.entries()) await ctx.recommend({ kind: "recommendation", title: f, rationale: "Local visibility check.", dedupeKey: `seo:${ctx.now.toISOString().slice(0, 7)}:${i}` });
    return { findings, faq, searchData: "unavailable: Google Search Console is not connected" };
  },
});

// ---------------------------------------------------------------- growth analyst

export async function growthCommandCentre(tdb: TenantDb, timeZone: string, from: string, to: string) {
  const start = zonedTime(from, "00:00", timeZone).toISOString();
  const end = zonedTime(addDays(to, 1), "00:00", timeZone).toISOString();
  const c = await one<Record<string, number>>(tdb,
    `select
       (select count(*) from bai_leads where created_at >= $1 and created_at < $2)::int leads,
       (select count(*) from bai_leads where created_at >= $1 and created_at < $2 and status in ('qualified','quoted','won'))::int qualified,
       (select count(*) from bai_quotes where created_at >= $1 and created_at < $2)::int quotes_prepared,
       (select count(*) from bai_quotes where decided_at >= $1 and decided_at < $2 and status = 'accepted')::int quotes_accepted,
       (select count(*) from bai_bookings where created_at >= $1 and created_at < $2 and status <> 'cancelled')::int bookings,
       (select count(*) from bai_jobs where completed_at >= $1 and completed_at < $2)::int jobs_completed,
       (select count(*) from bai_bookings b where b.created_at >= $1 and b.created_at < $2 and exists
          (select 1 from bai_bookings p where p.customer_id = b.customer_id and p.status = 'completed' and p.starts_at < b.created_at))::int repeat_bookings,
       (select count(*) from bai_bookings where status = 'no_show' and starts_at >= $1 and starts_at < $2)::int no_shows,
       (select count(*) from bai_approvals where status = 'pending')::int approvals_waiting,
       (select count(*) from bai_recommendations where status = 'open' and kind = 'issue')::int open_issues`, [start, end]);
  const attributed = await one<{ cents: number; n: number }>(tdb,
    `select coalesce(sum(i.subtotal_cents), 0)::bigint cents, count(*)::int n from bai_invoices i join bai_jobs j on j.id = i.job_id
     join bai_bookings b on b.id = j.booking_id join bai_leads l on l.id = b.lead_id
     where l.campaign_id is not null and i.status not in ('void','draft') and i.issued_at >= $1 and i.issued_at < $2`, [start, end]);
  const active = await tdb.query<{ provider: string }>("select provider from bai_integrations where status = 'operational'");
  const has = (p: string) => active.some((a) => a.provider === p);
  const notConnected = (what: string): Figure => ({ label: "UNAVAILABLE", reason: `${what} is not connected` });
  return {
    period: { from, to },
    counts: c,
    conversion: {
      quoteAcceptance: c.quotes_prepared ? c.quotes_accepted! / c.quotes_prepared : null,
      leadToBooking: c.leads ? c.bookings! / c.leads : null,
    },
    revenueAttributedToCampaigns: attributed.n
      ? { label: "ACTUAL", cents: Number(attributed.cents), source: `${plural(attributed.n, "invoice")} from enquiries that carried a campaign tracking code`, note: "Attribution: last tracked campaign on the enquiry." } as Figure
      : { label: "UNAVAILABLE", reason: "no invoiced job came from an enquiry with a campaign tracking code" } as Figure,
    marketingReach: has("facebook") || has("instagram") ? { label: "UNAVAILABLE", reason: "engagement import is not built yet" } as Figure : notConnected("No social account"),
    socialEngagement: has("facebook") || has("instagram") ? { label: "UNAVAILABLE", reason: "engagement import is not built yet" } as Figure : notConnected("No social account"),
    websiteVisits: has("google-analytics") ? { label: "UNAVAILABLE", reason: "analytics import is not built yet" } as Figure : notConnected("Google Analytics"),
    marketplaceProfileVisits: has("conaro-marketplace") ? { label: "UNAVAILABLE", reason: "profile-visit feed from the marketplace is not built yet" } as Figure : notConnected("The CONARO marketplace feed"),
  };
}

tool({
  name: "growth.command_centre", agent: "growth-analyst", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "campaigns", "operations.aggregate"],
  description: "What the workforce and the business achieved in a period, with utilisation and unused capacity.",
  async run(ctx, input: { from: string; to: string }) {
    const g = await growthCommandCentre(ctx.tdb, ctx.tenant.time_zone, input.from, input.to);
    const days = Math.max(1, Math.round((Date.parse(input.to) - Date.parse(input.from)) / 86_400_000) + 1);
    return { ...g, utilisation: await utilisation(ctx, input.from, Math.min(days, 62)) };
  },
});

tool({
  name: "growth.baseline", agent: "growth-analyst", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "operations.aggregate"],
  description: "Record the business's baseline (the first complete month) before any improvement is claimed.",
  async run(ctx) {
    const existing = await ctx.recall<{ month: string }>("baseline");
    if (existing) return { baseline: existing, recorded: false };
    const created = await one<{ created_at: string }>(ctx.tdb, "select created_at from bai_tenants");
    const firstFull = addDays(`${new Date(created.created_at).toISOString().slice(0, 7)}-01`, 32).slice(0, 7);
    const thisMonth = localParts(ctx.now, ctx.tenant.time_zone).date.slice(0, 7);
    if (firstFull >= thisMonth) return { recorded: false, reason: `baseline will be the first complete month (${firstFull})` };
    const end = addDays(addDays(`${firstFull}-01`, 32).slice(0, 7) + "-01", -1);
    const g = await growthCommandCentre(ctx.tdb, ctx.tenant.time_zone, `${firstFull}-01`, end);
    const baseline = { month: firstFull, counts: g.counts, conversion: g.conversion };
    await ctx.remember("baseline", baseline);
    return { baseline, recorded: true };
  },
});

tool({
  name: "growth.value_report", agent: "growth-analyst", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "campaigns", "finance", "operations.aggregate"],
  description: "Monthly AI value report: work done, outcomes, attributable revenue, owner-estimated time saved, AI usage and next steps.",
  async run(ctx, input: { month: string }) {
    const from = `${input.month}-01`;
    const to = addDays(addDays(from, 32).slice(0, 7) + "-01", -1);
    const start = zonedTime(from, "00:00", ctx.tenant.time_zone).toISOString();
    const end = zonedTime(addDays(to, 1), "00:00", ctx.tenant.time_zone).toISOString();
    const work = await ctx.tdb.query<{ agent_id: string; action_type: string; status: string; n: number }>(
      "select agent_id, action_type, status, count(*)::int n from bai_actions where created_at >= $1 and created_at < $2 group by 1, 2, 3 order by 4 desc", [start, end]);
    const g = await growthCommandCentre(ctx.tdb, ctx.tenant.time_zone, from, to);
    const fc = await financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, from, to);
    const minutes = ctx.policy.minutes_saved;
    const estimable = work.filter((w) => w.status === "done" || w.status === "simulated");
    const timeSaved = Object.keys(minutes).length
      ? { label: "ESTIMATE", minutes: estimable.reduce((s, w) => s + (minutes[w.action_type] ?? 0) * w.n, 0), source: "your own minutes-per-task estimates", excludesSimulated: false }
      : { label: "UNAVAILABLE", reason: "set how many minutes each kind of task takes you (Settings) to estimate time saved" };
    const ai = await one<{ calls: number; input: number; output: number }>(ctx.tdb,
      "select count(*)::int calls, coalesce(sum(input_tokens), 0)::bigint input, coalesce(sum(output_tokens), 0)::bigint output from bai_ai_usage where created_at >= $1 and created_at < $2", [start, end]);
    const baseline = await ctx.recall<{ month: string; counts: Record<string, number> }>("baseline");
    const simulatedCount = work.filter((w) => w.status === "simulated").reduce((s, w) => s + w.n, 0);
    const recs = await ctx.tdb.query<{ title: string; agent_id: string }>("select title, agent_id from bai_recommendations where status = 'open' order by created_at desc limit 5");
    const report = {
      month: input.month,
      workPerformed: work,
      simulatedNote: simulatedCount ? `${simulatedCount} external actions were SIMULATED: no message, post or payment actually left the system.` : null,
      outcomes: g.counts,
      cashReceived: fc.cashReceived,
      revenueAttributable: g.revenueAttributedToCampaigns,
      comparedWithBaseline: baseline && baseline.month < input.month ? { baselineMonth: baseline.month, baseline: baseline.counts, thisMonth: g.counts, note: "Change is not proof that the AI caused it." } : { label: "UNAVAILABLE", reason: "no baseline month recorded yet" },
      timeSaved,
      aiUsage: { calls: ai.calls, inputTokens: Number(ai.input), outputTokens: Number(ai.output), cost: { label: "UNAVAILABLE", reason: "per-token prices are not configured; see the Anthropic pricing page" } },
      subscriptionCost: { label: "UNAVAILABLE", reason: "plan prices are not set yet" },
      nextImprovements: recs,
    };
    await ctx.tdb.query("insert into bai_reports (kind, period, body) values ('value_report', $1, $2::text::jsonb) on conflict (tenant_id, kind, period) do update set body = excluded.body, created_at = now()", [input.month, json(report)]);
    await ctx.act({ actionType: "report.generate", title: `AI value report ${input.month}`, payload: { month: input.month }, idempotencyKey: `value_report:${input.month}:${ctx.now.toISOString().slice(0, 10)}` });
    return report;
  },
});

// ---------------------------------------------------------------- business manager

export async function dailySummary(ctx: AgentContext, date: string) {
  const tz = ctx.tenant.time_zone;
  const start = zonedTime(date, "00:00", tz).toISOString();
  const end = zonedTime(addDays(date, 1), "00:00", tz).toISOString();
  const g = await growthCommandCentre(ctx.tdb, tz, date, date);
  const cash = await one<{ cents: number; n: number }>(ctx.tdb, "select coalesce(sum(amount_cents), 0)::bigint cents, count(*)::int n from bai_payments where received_on = $1", [date]);
  const invoiced = await one<{ cents: number; n: number }>(ctx.tdb, "select coalesce(sum(subtotal_cents), 0)::bigint cents, count(*)::int n from bai_invoices where status not in ('void','draft') and issued_at >= $1 and issued_at < $2", [start, end]);
  const opps = await ctx.tdb.query<{ title: string }>("select title from bai_recommendations where kind = 'opportunity' and created_at >= $1 and created_at < $2", [start, end]);
  const work = await ctx.tdb.query<{ agent_id: string; status: string; n: number }>(
    "select agent_id, status, count(*)::int n from bai_actions where created_at >= $1 and created_at < $2 and status in ('done','simulated') group by 1, 2 order by 3 desc", [start, end]);
  const approvals = await ctx.tdb.query<{ ref: string; title: string }>("select ref, title from bai_approvals where status = 'pending' order by created_at limit 10");
  const issues = await ctx.tdb.query<{ title: string }>("select title from bai_recommendations where kind = 'issue' and status = 'open' order by created_at desc limit 10");
  const overdue = await one<{ n: number; cents: number }>(ctx.tdb, "select count(*)::int n, coalesce(sum(total_cents - paid_cents), 0)::bigint cents from bai_invoices where status in ('issued','partially_paid') and due_on < $1", [addDays(date, 1)]);
  const today = addDays(date, 1);
  const todayBookings = await one<{ n: number; unconfirmed: number }>(ctx.tdb,
    `select count(*)::int n, count(*) filter (where status = 'requested')::int unconfirmed from bai_bookings where status in ('requested','confirmed')
       and starts_at >= $1 and starts_at < $2`, [end, zonedTime(addDays(today, 1), "00:00", tz).toISOString()]);
  const newLeads = await one<{ n: number }>(ctx.tdb, "select count(*)::int n from bai_leads where status in ('new','qualified')");
  const bip = await one<{ intelligence: { gaps?: string[] } }>(ctx.tdb, "select intelligence from bai_profiles");
  const priorities: string[] = [];
  if (approvals.length) priorities.push(`Decide ${approvals.length} waiting approval${approvals.length > 1 ? "s" : ""} (agents are holding work for you).`);
  if (todayBookings.unconfirmed) priorities.push(`${todayBookings.unconfirmed} of today's bookings are not confirmed yet.`);
  if (overdue.n) priorities.push(`Follow up ${overdue.n} overdue invoice${overdue.n > 1 ? "s" : ""} (${money(Number(overdue.cents))}).`);
  if (newLeads.n) priorities.push(`${newLeads.n} enquir${newLeads.n > 1 ? "ies are" : "y is"} waiting for a quote or booking.`);
  if (bip.intelligence.gaps?.length) priorities.push(`Complete your profile: ${bip.intelligence.gaps.slice(0, 2).join("; ")}.`);
  if (!priorities.length) priorities.push("No urgent items. Review open recommendations.");
  const summary = {
    date,
    whatHappened: { newEnquiries: g.counts.leads, quotesPrepared: g.counts.quotes_prepared, quotesAccepted: g.counts.quotes_accepted, newBookings: g.counts.bookings, jobsCompleted: g.counts.jobs_completed },
    revenue: {
      cashReceived: cash.n ? { label: "ACTUAL", cents: Number(cash.cents), source: `${plural(cash.n, "payment")} recorded` } : { label: "UNAVAILABLE", reason: "no payments recorded that day" },
      invoiced: invoiced.n ? { label: "ACTUAL", cents: Number(invoiced.cents), source: `${plural(invoiced.n, "invoice")} issued (before tax)` } : { label: "UNAVAILABLE", reason: "no invoices issued that day" },
    },
    opportunities: opps.map((o) => o.title),
    agentWork: work,
    needsAttention: [...approvals.map((a) => `Approval ${a.ref}: ${a.title}`), ...issues.map((i) => i.title)],
    prioritiesToday: priorities,
  };
  await ctx.tdb.query("insert into bai_reports (kind, period, body) values ('daily_summary', $1, $2::text::jsonb) on conflict (tenant_id, kind, period) do update set body = excluded.body, created_at = now()", [date, json(summary)]);
  return summary;
}

tool({
  name: "manager.daily_summary", agent: "business-manager", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "finance", "operations.aggregate"],
  description: "The daily executive summary: what happened, revenue, opportunities, agent work, issues and today's priorities.",
  async run(ctx, input: { date?: string }) {
    const date = input.date ?? addDays(localParts(ctx.now, ctx.tenant.time_zone).date, -1);
    const s = await dailySummary(ctx, date);
    await ctx.act({ actionType: "report.generate", title: `Daily summary ${date}`, payload: { date }, idempotencyKey: `daily_summary:${date}` });
    return s;
  },
});

tool({
  name: "manager.capacity_review", agent: "business-manager", scopes: ["operations.aggregate", "bookings"],
  description: "Find unused working hours in the next 14 days and start the capacity workflow.",
  async run(ctx) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const u = await utilisation(ctx, today, 14);
    if (u.availableMinutes && u.unusedMinutes / u.availableMinutes >= 0.25) {
      const { emitEvent } = await import("../events.ts");
      await emitEvent(ctx.tdb, "capacity.unused", { unusedMinutes: u.unusedMinutes, availableMinutes: u.availableMinutes, from: today }, `capacity:${today}`);
    }
    return { from: today, availableMinutes: u.availableMinutes, unusedMinutes: u.unusedMinutes, utilisation: u.utilisation };
  },
});

tool({
  name: "manager.revenue_review", agent: "business-manager", scopes: ["finance", "invoices", "operations.aggregate"],
  description: "Compare month-to-date invoiced revenue with the owner's monthly target, pro-rated; start the corrective workflow if behind.",
  async run(ctx, input: { corrective?: boolean; findings?: unknown }) {
    const target = ctx.profile.objectives.monthlyRevenueTargetCents;
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const from = `${today.slice(0, 7)}-01`;
    const fc = await financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, from, today);
    if (!target) return { target: { label: "UNAVAILABLE", reason: "no monthly revenue target set" } };
    const daysIn = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    const day = Number(today.slice(8, 10));
    const expected = Math.round((target * day) / daysIn);
    const actualCents = fc.revenueInvoiced.label === "ACTUAL" ? fc.revenueInvoiced.cents : 0;
    const behind = day >= 7 && actualCents < expected * 0.8;
    if (input.corrective) {
      const plan = { month: today.slice(0, 7), target: { label: "TARGET", cents: target }, actual: fc.revenueInvoiced, proRatedTarget: { label: "TARGET", cents: expected }, findings: input.findings ?? null,
        actions: ["Review the drafted campaigns and approve the ones you want.", "Answer waiting enquiries and quotes first.", "Fill open dates shown in the capacity review."] };
      await ctx.tdb.query("insert into bai_reports (kind, period, body) values ('revenue_review', $1, $2::text::jsonb) on conflict (tenant_id, kind, period) do update set body = excluded.body", [today, json(plan)]);
      await ctx.recommend({ kind: "issue", title: `Revenue behind target: ${money(actualCents)} invoiced vs ${money(expected)} expected by today`, rationale: "A corrective plan is in Reports.", dedupeKey: `behind:${today.slice(0, 7)}` });
      return plan;
    }
    if (behind) {
      const { emitEvent } = await import("../events.ts");
      await emitEvent(ctx.tdb, "revenue.below_target", { month: today.slice(0, 7), expected, actual: actualCents }, `revenue_below:${today.slice(0, 7)}`);
    }
    return { target: { label: "TARGET", cents: target }, expectedByToday: { label: "TARGET", cents: expected }, invoiced: fc.revenueInvoiced, behind };
  },
});

async function periodicReport(ctx: AgentContext, kind: "weekly" | "monthly", from: string, to: string, period: string) {
  const g = await growthCommandCentre(ctx.tdb, ctx.tenant.time_zone, from, to);
  const fc = await financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, from, to);
  const recs = await ctx.tdb.query<{ kind: string; title: string }>("select kind, title from bai_recommendations where status = 'open' order by created_at desc limit 10");
  const body = { period: { from, to }, growth: g, finance: { revenueInvoiced: fc.revenueInvoiced, cashReceived: fc.cashReceived, accountsReceivable: fc.accountsReceivable, netOperatingResult: fc.netOperatingResult }, openRecommendations: recs };
  await ctx.tdb.query("insert into bai_reports (kind, period, body) values ($1, $2, $3::text::jsonb) on conflict (tenant_id, kind, period) do update set body = excluded.body, created_at = now()", [kind, period, json(body)]);
  await ctx.act({ actionType: "report.generate", title: `${kind} report ${period}`, payload: { period }, idempotencyKey: `${kind}_report:${period}` });
  return body;
}

tool({
  name: "manager.weekly_report", agent: "business-manager", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "finance", "campaigns", "operations.aggregate"],
  description: "Weekly management report for the last 7 days.",
  async run(ctx) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    return periodicReport(ctx, "weekly", addDays(today, -7), addDays(today, -1), today);
  },
});

tool({
  name: "manager.monthly_report", agent: "business-manager", scopes: ["leads", "quotes", "bookings", "jobs", "invoices", "finance", "campaigns", "operations.aggregate"],
  description: "Monthly management report for the previous month.",
  async run(ctx) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const first = `${today.slice(0, 7)}-01`;
    const prevFirst = `${addDays(first, -1).slice(0, 7)}-01`;
    return periodicReport(ctx, "monthly", prevFirst, addDays(first, -1), prevFirst.slice(0, 7));
  },
});

tool({
  name: "manager.chat", agent: "business-manager", scopes: ["profile", "services", "operations.aggregate", "finance", "leads", "bookings", "invoices"],
  description: "Answer the owner from the business's own records; recommendations only.",
  async run(ctx, input: { message: string; userId: string }) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    const from = `${today.slice(0, 7)}-01`;
    const g = await growthCommandCentre(ctx.tdb, ctx.tenant.time_zone, from, today);
    const fc = await financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, from, today);
    const bip = await one<{ intelligence: unknown }>(ctx.tdb, "select intelligence from bai_profiles");
    const facts = { monthToDate: { counts: g.counts, revenueInvoiced: fc.revenueInvoiced, cashReceived: fc.cashReceived, receivable: fc.accountsReceivable }, profile: bip.intelligence };
    const history = (await ctx.recall<{ role: string; text: string }[]>("chat")) ?? [];
    let reply: string; let recommendations: { action: string; rationale: string }[] = []; let usedModel = false;
    if (await meter(ctx.tdb, "ai_calls")) {
      const owner = wrapUntrusted("owner message", input.message, 4000);
      const started = Date.now();
      const res = await ctx.deps.reasoning.analyse({
        agentId: "business-ai:business-manager", taskId: `chat:${ctx.now.toISOString()}`,
        system: `You are the AI Business Manager for ${ctx.tenant.name}, a ${ctx.pack.name} business. Answer only from the RECORDS below; say "not recorded" when data is missing. Label targets as TARGET and estimates as ESTIMATE. You recommend; you never claim to have done anything. ${UNTRUSTED_DATA_POLICY}\nRECORDS: ${JSON.stringify(facts)}`,
        prompt: `Recent conversation: ${JSON.stringify(history.slice(-6))}\nThe owner asks:\n${owner.text}\nAnswer in "summary"; put suggested next steps in "recommendations".`,
      });
      await ctx.tdb.query("insert into bai_ai_usage (agent_id, purpose, provider, model, outcome, input_tokens, output_tokens, latency_ms) values ($1, 'chat', $2, $3, $4, $5, $6, $7)",
        [ctx.agent.id, res.usage.provider, res.usage.model, res.usage.outcome, res.usage.inputTokens, res.usage.outputTokens, Date.now() - started]);
      usedModel = !res.simulated;
      reply = res.simulated ? simulatedChat(facts) : res.analysis.summary;
      recommendations = res.analysis.recommendations.map((r) => ({ action: r.action, rationale: r.rationale }));
    } else reply = `Your plan's monthly AI limit is reached. ${simulatedChat(facts)}`;
    await ctx.remember("chat", [...history, { role: "owner", text: input.message.slice(0, 2000) }, { role: "manager", text: reply.slice(0, 4000) }].slice(-20));
    return { reply, recommendations, usedModel };
  },
});

function simulatedChat(f: { monthToDate: { counts: Record<string, number>; revenueInvoiced: Figure; receivable: Figure } }): string {
  const r = f.monthToDate.revenueInvoiced;
  return `AI reasoning is not configured, so here are your records for this month: ${f.monthToDate.counts.leads} enquiries, ${f.monthToDate.counts.bookings} bookings, ${f.monthToDate.counts.jobs_completed} jobs completed; invoiced ${r.label === "UNAVAILABLE" ? "nothing yet" : money(r.cents)}.`;
}
