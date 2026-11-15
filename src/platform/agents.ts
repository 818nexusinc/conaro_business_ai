/**
 * The platform's own AI workforce: agents that work for CONARO Business AI itself (management, growth and
 * marketing, pricing, sales and onboarding, customer success, finance, compliance and security, website quality).
 *
 * Rules (CLAUDE.md hard limits):
 *  - They read platform data as aggregates only: counts and plan/industry ids. No business names, people,
 *    emails or messages ever reach them (in particular the marketing agent has no personal data).
 *  - They never act externally. Everything they suggest goes to the owner's approval queue; approving a website
 *    or plan proposal saves a *draft* that still needs Publish, and outreach is a draft a person sends.
 *  - Figures they compute from records are labelled ACTUAL; anything derived from published prices is ESTIMATE.
 */
import type { Db } from "../shared/db.ts";
import { json, maybeOne } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import type { ReasoningPort } from "../shared/reasoning.ts";
import { wrapUntrusted } from "../shared/untrusted.ts";
import { PLANS } from "../catalog/plans.ts";
import { publishedPlans, savePlanDraft, PlanSettingsSchema } from "../admin/plans.ts";
import { pendingChanges, saveDraft, MAX_TEXT } from "../admin/content.ts";
import { adminAudit, type AdminSession } from "../admin/auth.ts";
import { COPY } from "../landing/copy.ts";

export interface PlatformContext {
  setupKeySet: boolean;
  frReviewed: boolean;
  billingProblem: string | null;
  billingMode: "test" | "live" | null;
  webhookConfigured: boolean;
  liveApproved: boolean;
}

export const PLATFORM_AGENTS = [
  { id: "platform-manager", name: "Platform Manager", role: "Runs the daily briefing: what changed, what needs the owner, the three priorities." },
  { id: "growth-marketing", name: "Growth and Marketing Director", role: "Watches sign-ups and the website, drafts copy improvements for the editor (as drafts)." },
  { id: "pricing", name: "Pricing Analyst", role: "Checks plans, published prices and Stripe links; drafts plan changes for the owner to publish." },
  { id: "sales-onboarding", name: "Sales and Onboarding Lead", role: "Finds new businesses that stall during set-up and drafts a check-in for a person to send." },
  { id: "customer-success", name: "Customer Success Manager", role: "Spots paused businesses and billing problems and drafts the follow-up." },
  { id: "finance", name: "Finance Controller", role: "Recurring revenue estimate from published prices, failed payments, billing health." },
  { id: "compliance-security", name: "Compliance and Security Officer", role: "Checks set-up keys, live-charging approval, webhooks, French review and admin coverage." },
  { id: "site-quality", name: "Website Quality Lead", role: "Watches unpublished drafts, hidden sections and the editor's changes." },
] as const;
export type PlatformAgentId = (typeof PLATFORM_AGENTS)[number]["id"];

interface Proposal { kind: "task" | "site.copy" | "plans.draft" | "outreach.draft"; title: string; rationale: string; evidence: string[]; payload?: Record<string, unknown>; dedupe: string }
interface AgentOutput { summary: string; findings: { label: string; value: string; kind: "ACTUAL" | "ESTIMATE" | "STATUS" }[]; proposals: Proposal[]; simulated?: boolean }

/** Aggregate snapshot: counts only. */
export async function snapshot(db: Db) {
  const n = async (q: string, p: unknown[] = []) => Number((await db.query<{ n: number }>(q, p))[0]?.n ?? 0);
  const real = "not t.is_demo and t.status <> 'cancelled'";
  return {
    businesses: await n(`select count(*)::int n from bai_tenants t where ${real}`),
    newBusinesses7: await n(`select count(*)::int n from bai_tenants t where ${real} and t.created_at > now() - interval '7 days'`),
    signups7: await n("select count(*)::int n from bai_signups where created_at > now() - interval '7 days'"),
    signupsPrev7: await n("select count(*)::int n from bai_signups where created_at between now() - interval '14 days' and now() - interval '7 days'"),
    marketingOptIns30: await n("select count(*)::int n from bai_signups where marketing_consent and created_at > now() - interval '30 days'"),
    byPlan: await db.query<{ plan: string; n: number }>(`select s.plan, count(*)::int n from bai_subscriptions s join bai_tenants t on t.id = s.tenant_id where ${real} group by 1`),
    byIndustry: await db.query<{ industry: string; n: number }>(`select t.industry, count(*)::int n from bai_tenants t where ${real} group by 1 order by 2 desc limit 5`),
    paused: await n(`select count(*)::int n from bai_tenants t where ${real} and t.paused`),
    stalled: await n(`select count(*)::int n from bai_tenants t left join bai_profiles p on p.tenant_id = t.id where ${real} and t.created_at < now() - interval '3 days' and coalesce(p.completeness, 0) < 50`),
    paidActive: await db.query<{ plan: string; n: number }>(`select a.plan, count(*)::int n from bai_billing_accounts a join bai_tenants t on t.id = a.tenant_id where ${real} and a.stripe_status in ('active','trialing') and not a.livemode group by 1`),
    paidActiveLive: await db.query<{ plan: string; n: number }>(`select a.plan, count(*)::int n from bai_billing_accounts a join bai_tenants t on t.id = a.tenant_id where ${real} and a.stripe_status = 'active' and a.livemode group by 1`),
    pastDue: await n(`select count(*)::int n from bai_subscriptions s join bai_tenants t on t.id = s.tenant_id where ${real} and s.status = 'past_due'`),
    failedPayments30: await n("select count(*)::int n from bai_billing_events where type = 'invoice.payment_failed' and received_at > now() - interval '30 days'"),
    owners: await n("select count(*)::int n from bai_platform_admins where role = 'owner' and status = 'active'"),
    siteDrafts: await pendingChanges(db),
    layout: (await maybeOne<{ published_value: string | null }>(db, "select published_value from bai_site_content where key = 'layout' and lang = '*'"))?.published_value ?? null,
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

const money = (c: number) => `$${(c / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function runOne(id: PlatformAgentId, db: Db, s: Snapshot, ctx: PlatformContext, reasoning: ReasoningPort): Promise<AgentOutput> {
  const plans = await publishedPlans(db);
  switch (id) {
    case "platform-manager": {
      const open = await db.query<{ agent_id: string; title: string }>("select agent_id, title from bai_platform_proposals where status = 'pending' order by created_at limit 3");
      return {
        summary: `${s.businesses} businesses, ${s.signups7} sign-ups this week (${s.signupsPrev7} the week before), ${open.length ? `${open.length}+ proposals waiting` : "no proposals waiting"}.`,
        findings: [
          { label: "Businesses (not demo)", value: String(s.businesses), kind: "ACTUAL" },
          { label: "Sign-ups, last 7 days", value: `${s.signups7} (previous 7 days: ${s.signupsPrev7})`, kind: "ACTUAL" },
          { label: "Plan mix", value: s.byPlan.map((p) => `${p.plan} ${p.n}`).join(", ") || "none", kind: "ACTUAL" },
          { label: "Top industries", value: s.byIndustry.map((i) => `${i.industry} ${i.n}`).join(", ") || "none", kind: "ACTUAL" },
          ...open.map((p, i) => ({ label: `Priority ${i + 1}`, value: `${p.title} (${p.agent_id})`, kind: "STATUS" as const })),
        ],
        proposals: [],
      };
    }
    case "pricing": {
      const proposals: Proposal[] = [];
      const unannounced = PLANS.filter((p) => plans[p.id]!.priceCents === null).map((p) => plans[p.id]!.name.en);
      if (unannounced.length) proposals.push({ kind: "task", title: "Announce plan prices", rationale: `These plans show "Price announced before billing starts": ${unannounced.join(", ")}. Set and publish prices in Plans and pricing when you have decided them. The agents do not invent prices.`, evidence: [`plans without a published price: ${unannounced.length}`], dedupe: "pricing:unannounced" });
      const unlinked = PLANS.filter((p) => plans[p.id]!.priceCents !== null && !plans[p.id]!.stripePriceId).map((p) => plans[p.id]!.name.en);
      if (unlinked.length && !ctx.billingProblem) proposals.push({ kind: "task", title: "Link priced plans to Stripe", rationale: `${unlinked.join(", ")} have a published price but no Stripe price, so owners cannot subscribe to them. Add the price ids in Billing.`, evidence: unlinked, dedupe: "pricing:unlinked" });
      if (!PLANS.some((p) => plans[p.id]!.recommended)) proposals.push({ kind: "plans.draft", title: "Mark Growth as the recommended plan", rationale: "No plan is highlighted on the website; a recommended plan helps visitors choose. This only prepares a draft.", evidence: ["recommended plans: 0"], payload: { plan: "growth", settings: { ...plans.growth!, recommended: true } }, dedupe: "pricing:recommended" });
      return { summary: `${PLANS.length - unannounced.length} of ${PLANS.length} plans have a published price.`, findings: PLANS.map((p) => ({ label: plans[p.id]!.name.en, value: plans[p.id]!.priceCents === null ? "price not announced" : `${money(plans[p.id]!.priceCents!)} / month${plans[p.id]!.stripePriceId ? " · Stripe linked" : ""}`, kind: "STATUS" as const })), proposals };
    }
    case "finance": {
      const est = (rows: { plan: string; n: number }[]) => rows.reduce((sum, r) => sum + (plans[r.plan]?.priceCents ?? 0) * r.n, 0);
      const live = est(s.paidActiveLive); const test = est(s.paidActive);
      const proposals: Proposal[] = s.failedPayments30 ? [{ kind: "task", title: "Review failed payments", rationale: `${s.failedPayments30} payment(s) failed in the last 30 days (Stripe events). Check Billing and contact the businesses if needed.`, evidence: [`invoice.payment_failed events, 30 days: ${s.failedPayments30}`], dedupe: "finance:failed-payments" }] : [];
      return {
        summary: s.paidActiveLive.length ? `Monthly recurring revenue estimate: ${money(live)}.` : "No live paying subscriptions yet; nothing is charged.",
        findings: [
          { label: "Monthly recurring revenue (live)", value: money(live), kind: "ESTIMATE" },
          { label: "Test-mode subscriptions (no real money)", value: `${s.paidActive.reduce((a, r) => a + r.n, 0)} · would be ${money(test)} / month`, kind: "ESTIMATE" },
          { label: "Businesses past due", value: String(s.pastDue), kind: "ACTUAL" },
          { label: "Failed payments, 30 days", value: String(s.failedPayments30), kind: "ACTUAL" },
        ],
        proposals,
      };
    }
    case "sales-onboarding": {
      const proposals: Proposal[] = s.stalled ? [{ kind: "outreach.draft", title: `Check in with ${s.stalled} business(es) stuck in set-up`, rationale: `${s.stalled} business(es) joined over 3 days ago and their profile is under half complete. A short, helpful check-in usually unblocks set-up. This is a draft: a person sends it from the owner's own email, only to those businesses (account messages, not marketing).`, evidence: [`stalled set-ups: ${s.stalled}`],
        payload: { subject: "Need a hand finishing your CONARO Business AI set-up?", body: "Hi,\n\nI noticed your CONARO Business AI workspace isn't fully set up yet. The agents work best once your services, prices and hours are in. Would a 15-minute call this week help? Reply with a time that suits you.\n\nThanks,\n[Your name]\nCONARO Business AI" }, dedupe: "sales:stalled" }] : [];
      return { summary: `${s.newBusinesses7} new business(es) this week; ${s.stalled} stalled in set-up.`, findings: [{ label: "New businesses, 7 days", value: String(s.newBusinesses7), kind: "ACTUAL" }, { label: "Stalled set-ups (>3 days, <50% profile)", value: String(s.stalled), kind: "ACTUAL" }], proposals };
    }
    case "customer-success": {
      const proposals: Proposal[] = [];
      if (s.pastDue) proposals.push({ kind: "outreach.draft", title: `Help ${s.pastDue} business(es) with a payment problem`, rationale: "Their subscription is past due. A friendly note with the billing link avoids an interruption. Draft only; a person sends it.", evidence: [`past due: ${s.pastDue}`],
        payload: { subject: "Your CONARO Business AI payment didn't go through", body: "Hi,\n\nYour last payment for CONARO Business AI didn't go through. You can update your card from Plan and usage → Manage billing. If anything is unclear, just reply.\n\nThanks,\n[Your name]" }, dedupe: "success:past-due" });
      if (s.paused) proposals.push({ kind: "task", title: `${s.paused} business(es) paused all agents`, rationale: "Owners paused their agents. Find out why (worry, error, seasonality) before it becomes a cancellation.", evidence: [`paused: ${s.paused}`], dedupe: "success:paused" });
      return { summary: `${s.pastDue} past due, ${s.paused} paused.`, findings: [{ label: "Past due", value: String(s.pastDue), kind: "ACTUAL" }, { label: "Agents paused", value: String(s.paused), kind: "ACTUAL" }], proposals };
    }
    case "compliance-security": {
      const proposals: Proposal[] = [];
      if (ctx.setupKeySet && s.owners > 0) proposals.push({ kind: "task", title: "Remove BAI_SETUP_KEY from the host", rationale: "A platform owner exists; the set-up key only opens /setup and first-owner creation, so leaving it set adds risk.", evidence: ["setup key set", `owners: ${s.owners}`], dedupe: "sec:setup-key" });
      if (s.owners < 2) proposals.push({ kind: "task", title: "Add a second platform owner", rationale: "With one owner, a lost password locks everyone out of pricing and billing.", evidence: [`owners: ${s.owners}`], dedupe: "sec:owners" });
      if (!ctx.frReviewed) proposals.push({ kind: "task", title: "Have the French website reviewed", rationale: "French marketing copy must be reviewed by a fluent reader before publication (BAI_FR_REVIEWED_BY); until then the French page says it is under review.", evidence: ["BAI_FR_REVIEWED_BY not set"], dedupe: "sec:fr-review" });
      if (!ctx.billingProblem && !ctx.webhookConfigured) proposals.push({ kind: "task", title: "Configure the Stripe webhook secret", rationale: "Stripe is configured but STRIPE_WEBHOOK_SECRET is not, so subscriptions are never confirmed.", evidence: ["webhook secret missing"], dedupe: "sec:webhook" });
      return { summary: proposals.length ? `${proposals.length} item(s) to tighten.` : "No configuration issues found.", findings: [
        { label: "Billing", value: ctx.billingProblem ?? `${ctx.billingMode} mode${ctx.liveApproved ? " (live charging approved)" : ""}`, kind: "STATUS" },
        { label: "Platform owners", value: String(s.owners), kind: "ACTUAL" }, { label: "French review", value: ctx.frReviewed ? "recorded" : "pending", kind: "STATUS" }], proposals };
    }
    case "site-quality": {
      const proposals: Proposal[] = [];
      const old = s.siteDrafts.filter((d) => Date.now() - new Date(d.updated_at).getTime() > 3 * 86400_000);
      if (old.length) proposals.push({ kind: "task", title: `Publish or discard ${old.length} old website draft(s)`, rationale: "Drafts older than 3 days are easy to forget and to publish by accident later.", evidence: old.slice(0, 5).map((d) => `${d.key} (${d.lang})`), dedupe: "site:old-drafts" });
      const hidden = (() => { try { return (JSON.parse(s.layout ?? "{}") as { hidden?: string[] }).hidden ?? []; } catch { return []; } })();
      if (hidden.includes("plans")) proposals.push({ kind: "task", title: "The Plans section is hidden", rationale: "Visitors cannot choose a plan or sign up from the page while Plans is hidden.", evidence: ["layout hidden: plans"], dedupe: "site:plans-hidden" });
      return { summary: `${s.siteDrafts.length} unpublished draft(s); hidden sections: ${hidden.join(", ") || "none"}.`, findings: [{ label: "Unpublished drafts", value: String(s.siteDrafts.length), kind: "ACTUAL" }], proposals };
    }
    case "growth-marketing": {
      const trend = s.signups7 - s.signupsPrev7;
      const findings: AgentOutput["findings"] = [
        { label: "Sign-ups, 7 days", value: `${s.signups7} (${trend >= 0 ? "+" : ""}${trend} vs previous week)`, kind: "ACTUAL" },
        { label: "Marketing opt-ins, 30 days", value: String(s.marketingOptIns30), kind: "ACTUAL" },
      ];
      // Copy suggestions: the model sees only the current headline texts and aggregate counts (no personal data).
      const current = { "hero.title1": COPY.en.h1.split(". ")[0] + ".", "hero.title2": COPY.en.h1.split(". ").slice(1).join(". "), "hero.lead": COPY.en.lead(18), "team.title": COPY.en.teamTitle };
      const data = wrapUntrusted("platform:landing-copy", JSON.stringify({ current, signups7: s.signups7, signupsPrev7: s.signupsPrev7, topIndustries: s.byIndustry.map((i) => i.industry) }));
      const r = await reasoning.analyse({ agentId: "platform:growth-marketing", taskId: "landing-copy", system:
        "You are the growth and marketing director of CONARO Business AI, an AI workforce for local service businesses in Greater Moncton (pilot product). Suggest at most 2 clearer English website texts. Never invent numbers, prices, customers, testimonials or results, and never claim messages, posts or payments already go out. Each proposedAction must have actionType \"site.copy\" and payloadJson {\"key\": one of hero.title1|hero.title2|hero.lead|team.title, \"lang\": \"en\", \"value\": text}.",
        prompt: `Data:\n${data.text}` });
      const proposals: Proposal[] = [];
      for (const a of r.analysis.proposedActions.slice(0, 2)) {
        if (a.actionType !== "site.copy") continue;
        let p: { key?: unknown; lang?: unknown; value?: unknown };
        try { p = JSON.parse(a.payloadJson); } catch { continue; }
        if (typeof p.key !== "string" || !(p.key in current) || p.lang !== "en" || typeof p.value !== "string" || !p.value.trim() || p.value.length > 300) continue;
        if (/\d+\s?%|\$\s?\d|testimonial|guarantee/i.test(p.value)) continue; // no invented figures or promises
        proposals.push({ kind: "site.copy", title: `New wording for ${p.key}`, rationale: a.rationale.slice(0, 1000), evidence: [`current: ${current[p.key as keyof typeof current]}`], payload: { key: p.key, lang: "en", value: p.value.trim() }, dedupe: `copy:${p.key}` });
      }
      return { summary: r.simulated ? "AI copy suggestions need ANTHROPIC_API_KEY; sign-up trend recorded." : `${proposals.length} copy suggestion(s) for review.`, findings, proposals, simulated: r.simulated };
    }
  }
}

/** Runs every platform agent once and records runs and proposals. */
export async function runPlatformAgents(db: Db, reasoning: ReasoningPort, ctx: PlatformContext, triggeredBy: string): Promise<{ agent: string; outcome: string; proposals: number }[]> {
  const s = await snapshot(db);
  const results: { agent: string; outcome: string; proposals: number }[] = [];
  // The manager runs last so its priorities include what the others just proposed.
  const order = [...PLATFORM_AGENTS.filter((a) => a.id !== "platform-manager"), PLATFORM_AGENTS[0]];
  for (const a of order) {
    const run = await maybeOne<{ id: number }>(db, "insert into bai_platform_agent_runs (agent_id, triggered_by) values ($1, $2) returning id::int id", [a.id, triggeredBy]);
    try {
      const out = await runOne(a.id, db, s, ctx, reasoning);
      let created = 0;
      for (const p of out.proposals) {
        const r = await db.query(`insert into bai_platform_proposals (agent_id, kind, title, rationale, evidence, payload, dedupe_key) values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7)
          on conflict (dedupe_key) where status = 'pending' do nothing returning id`, [a.id, p.kind, p.title.slice(0, 200), p.rationale.slice(0, 4000), json(p.evidence), json(p.payload ?? {}), p.dedupe]);
        created += r.length;
      }
      // A proposal whose reason has gone away (fixed, or no longer true) is withdrawn rather than left stale.
      await db.query("update bai_platform_proposals set status = 'expired', outcome = 'No longer applies (the agent re-checked).', decided_at = now() where agent_id = $1 and status = 'pending' and not (dedupe_key = any($2::text[]))",
        [a.id, out.proposals.map((p) => p.dedupe)]);
      await db.query("update bai_platform_agent_runs set finished_at = now(), outcome = 'succeeded', summary = $2::text::jsonb, simulated = $3 where id = $1",
        [run!.id, json({ summary: out.summary, findings: out.findings, proposals: out.proposals.length }), Boolean(out.simulated)]);
      results.push({ agent: a.id, outcome: "succeeded", proposals: created });
    } catch (err) {
      await db.query("update bai_platform_agent_runs set finished_at = now(), outcome = 'failed', summary = $2::text::jsonb where id = $1", [run!.id, json({ error: (err as Error).message.slice(0, 500) })]);
      results.push({ agent: a.id, outcome: "failed", proposals: 0 });
    }
  }
  return results;
}

/** Daily: runs the platform agents when they have not run in the last 20 hours (the cycle may tick more often). */
export async function runPlatformAgentsIfDue(db: Db, reasoning: ReasoningPort, ctx: PlatformContext): Promise<boolean> {
  const recent = await maybeOne(db, "select 1 from bai_platform_agent_runs where agent_id = 'platform-manager' and started_at > now() - interval '20 hours'");
  if (recent) return false;
  await runPlatformAgents(db, reasoning, ctx, "system:daily-cycle");
  return true;
}

/** The owner decides. Approving never publishes or sends anything: website and plan changes become drafts. */
export async function decideProposal(db: Db, admin: AdminSession, id: string, decision: "approve" | "reject"): Promise<string> {
  const p = await maybeOne<{ kind: string; payload: Record<string, unknown>; status: string; title: string }>(db, "select kind, payload, status, title from bai_platform_proposals where id = $1", [id]);
  if (!p) throw new PermanentError("Proposal not found.");
  if (p.status !== "pending") throw new PermanentError("This proposal was already decided.");
  let outcome = "rejected"; let status = "rejected";
  if (decision === "approve") {
    if (p.kind === "site.copy") {
      const key = String(p.payload.key ?? ""); const value = String(p.payload.value ?? "").slice(0, MAX_TEXT);
      await saveDraft(db, admin, key, p.payload.lang === "fr" ? "fr" : "en", value);
      outcome = `Saved as a website draft (${key}). Review it in the editor and publish when ready.`; status = "applied";
    } else if (p.kind === "plans.draft") {
      const settings = PlanSettingsSchema.parse(p.payload.settings);
      await savePlanDraft(db, admin, String(p.payload.plan ?? ""), settings);
      outcome = "Saved as a plan draft. Publish it in Plans and pricing."; status = "applied";
    } else if (p.kind === "outreach.draft") {
      outcome = "Approved as a draft. Nothing was sent: copy it and send it yourself to the right businesses."; status = "approved";
    } else { outcome = "Noted."; status = "approved"; }
  }
  await db.query("update bai_platform_proposals set status = $2, outcome = $3, decided_by = $4, decided_at = now() where id = $1", [id, status, outcome, admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: `proposal.${decision}`, subject: id, detail: { title: p.title, kind: p.kind, outcome } });
  return outcome;
}
