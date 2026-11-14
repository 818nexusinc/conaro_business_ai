import type { Db } from "./shared/db.ts";
import { json, maybeOne, one } from "./shared/db.ts";
import { errorDetails, PermanentError } from "./shared/errors.ts";
import { periodKey } from "./shared/periods.ts";
import { withTenant, activeTenantIds, type TenantDb } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";
import { emitEvent, type EventType } from "./events.ts";
import type { AgentDeps } from "./agent-context.ts";
import { TOOLS, runTool } from "./tools/index.ts";
import { addDays, isoDate, localParts } from "./time.ts";
import { meter } from "./usage.ts";
import { MarketplaceFeedClient, syncMarketplace } from "./interop/marketplace.ts";

type Outputs = Record<string, unknown>;
interface RunState { event: Record<string, unknown>; outputs: Outputs; now: Date; timeZone: string }
type Input = Record<string, unknown> | { skip: string };

export interface WorkflowStep {
  key: string;
  tool: string;
  input: (s: RunState, tdb: TenantDb) => Input | Promise<Input>;
}
export interface Workflow { id: string; trigger: EventType; description: string; steps: WorkflowStep[] }

const out = <T = Record<string, unknown>>(s: RunState, key: string) => (s.outputs[key] ?? {}) as T;
const today = (s: RunState) => localParts(s.now, s.timeZone).date;
const all = (tool: string, input: (s: RunState) => Record<string, unknown> = () => ({})): WorkflowStep => ({ key: tool, tool, input });

/** The brief's §6 scenarios, plus the recurring daily, weekly and monthly duties. */
export const WORKFLOWS: Workflow[] = [
  {
    id: "enquiry", trigger: "lead.received", description: "A customer submits a service request.",
    steps: [
      { key: "qualify", tool: "sales.qualify_lead", input: (s) => ({ leadId: s.event.leadId }) },
      { key: "quote", tool: "quote.prepare", input: (s) => out<{ qualified?: boolean }>(s, "qualify").qualified ? { leadId: s.event.leadId } : { skip: "enquiry not qualified" } },
      { key: "availability", tool: "booking.check_availability", input: async (s, tdb) => {
        const q = out<{ serviceId?: string }>(s, "qualify");
        const lead = await one<{ desired_date: string | null; qualification: { desiredTime?: string } }>(tdb, "select desired_date, qualification from bai_leads where id = $1", [s.event.leadId]);
        if (!q.serviceId || !lead.desired_date) return { skip: "no service or date to check" };
        return { serviceId: q.serviceId, date: isoDate(lead.desired_date), time: lead.qualification.desiredTime ?? "09:00" };
      } },
      { key: "reply", tool: "service.draft_reply", input: (s) => ({ leadId: s.event.leadId, quoteRef: out<{ ref?: string }>(s, "quote").ref ?? null, available: out<{ available?: boolean }>(s, "availability").available ?? null }) },
      { key: "crm", tool: "crm.record_opportunity", input: (s) => ({ leadId: s.event.leadId }) },
    ],
  },
  {
    id: "quote_accepted", trigger: "quote.accepted", description: "A customer accepts a quote and picks a time.",
    steps: [
      { key: "book", tool: "booking.confirm", input: async (s, tdb) => {
        const q = await one<{ lead_id: string | null; customer_id: string; service_id: string | null }>(tdb,
          "select q.lead_id, q.customer_id, l.service_id from bai_quotes q left join bai_leads l on l.id = q.lead_id where q.id = $1", [s.event.quoteId]);
        if (!q.service_id) return { skip: "quote has no service" };
        return { quoteId: s.event.quoteId, leadId: q.lead_id, serviceId: q.service_id, customerId: q.customer_id, startsAt: s.event.startsAt };
      } },
    ],
  },
  {
    id: "booking_confirmed", trigger: "booking.confirmed", description: "A booking is confirmed.",
    steps: [
      { key: "assign", tool: "workforce.assign", input: (s) => ({ bookingId: s.event.bookingId }) },
      { key: "job", tool: "jobs.create_from_booking", input: (s) => ({ bookingId: s.event.bookingId }) },
      { key: "confirm_customer", tool: "service.booking_confirmation", input: (s) => ({ bookingId: s.event.bookingId }) },
    ],
  },
  {
    id: "job_completed", trigger: "job.completed", description: "A job is completed.",
    steps: [
      { key: "invoice", tool: "invoice.prepare", input: (s) => ({ jobId: s.event.jobId }) },
      { key: "follow_up", tool: "crm.post_job_follow_up", input: (s) => ({ jobId: s.event.jobId }) },
      { key: "feedback", tool: "reputation.request_feedback", input: (s) => ({ jobId: s.event.jobId }) },
    ],
  },
  {
    id: "unused_capacity", trigger: "capacity.unused", description: "The business has unused capacity in the next two weeks.",
    steps: [
      { key: "campaign", tool: "marketing.capacity_campaign", input: (s) => ({ unusedMinutes: s.event.unusedMinutes, availableMinutes: s.event.availableMinutes }) },
      { key: "follow_ups", tool: "sales.follow_up_quotes", input: () => ({}) },
    ],
  },
  {
    id: "revenue_below_target", trigger: "revenue.below_target", description: "Month-to-date revenue is behind the owner's target.",
    steps: [
      { key: "finance", tool: "finance.command_centre", input: (s) => ({ from: `${today(s).slice(0, 7)}-01`, to: today(s) }) },
      { key: "marketing", tool: "marketing.plan_month", input: (s) => ({ month: today(s).slice(0, 7) }) },
      { key: "sales", tool: "sales.lost_reasons", input: () => ({}) },
      { key: "capacity", tool: "workforce.utilisation", input: () => ({}) },
      { key: "plan", tool: "manager.revenue_review", input: (s) => ({ corrective: true, findings: {
        lostReasons: out(s, "sales").reasons ?? null,
        unusedMinutesNext14: (out<{ next14?: { unusedMinutes: number } }>(s, "capacity").next14?.unusedMinutes) ?? null,
        campaignsDrafted: (out<{ drafted?: unknown[] }>(s, "marketing").drafted ?? []).length } }) },
    ],
  },
  { id: "hourly", trigger: "schedule.hourly", description: "Every hour.", steps: [all("booking.send_reminders")] },
  {
    id: "daily", trigger: "schedule.daily", description: "Every morning.",
    steps: [all("invoice.overdue_reminders"), all("jobs.find_delays"), all("admin.deadline_reminders"), all("manager.capacity_review"), all("manager.revenue_review"), all("manager.daily_summary")],
  },
  {
    id: "weekly", trigger: "schedule.weekly", description: "Every Monday.",
    steps: [all("sales.follow_up_quotes"), all("accounting.suggest_categories"), all("reputation.analyse_feedback"), all("booking.group_nearby"),
      all("quote.acceptance_review"), all("finance.service_profitability"), all("manager.weekly_report")],
  },
  {
    id: "monthly", trigger: "schedule.monthly", description: "First day of the month.",
    steps: [all("marketing.plan_month"), all("social.content_calendar", (s) => ({ month: addDays(`${today(s).slice(0, 7)}-01`, 32).slice(0, 7) })),
      all("seo.profile_audit"), all("crm.inactive_customers"), all("tax.registration_check"), all("growth.baseline"),
      all("growth.value_report", (s) => ({ month: addDays(`${today(s).slice(0, 7)}-01`, -1).slice(0, 7) })), all("manager.monthly_report")],
  },
];

const BY_TRIGGER = new Map(WORKFLOWS.map((w) => [w.trigger, w]));
const BY_ID = new Map(WORKFLOWS.map((w) => [w.id, w]));
const MAX_ATTEMPTS = 5;

/** Emits the tenant's due schedule events, once per local period. Daily work starts at 07:00 local time. */
export async function scheduleTenant(tdb: TenantDb, now: Date): Promise<string[]> {
  const t = await one<{ time_zone: string; paused: boolean }>(tdb, "select time_zone, paused from bai_tenants");
  if (t.paused) return [];
  const local = localParts(now, t.time_zone);
  const emitted: string[] = [];
  const add = async (type: EventType, key: string) => { if (await emitEvent(tdb, type, { period: key }, `${type}:${key}`)) emitted.push(`${type}:${key}`); };
  await add("schedule.hourly", `${local.date}T${local.hhmm.slice(0, 2)}`);
  if (local.minutes >= 7 * 60) {
    await add("schedule.daily", periodKey("daily", now, t.time_zone));
    if (local.weekday === 1) await add("schedule.weekly", periodKey("weekly", now, t.time_zone));
    if (local.date.endsWith("-01")) await add("schedule.monthly", periodKey("monthly", now, t.time_zone));
  }
  return emitted;
}

/** Turns pending events into workflow runs (one per event). */
export async function startRuns(tdb: TenantDb, now: Date = new Date()): Promise<number> {
  const events = await tdb.query<{ id: string; type: EventType; payload: Record<string, unknown> }>(
    "select id, type, payload from bai_events where status = 'pending' order by created_at limit 100");
  let started = 0;
  for (const e of events) {
    const wf = BY_TRIGGER.get(e.type);
    if (wf) {
      const r = await tdb.query("insert into bai_workflow_runs (workflow, event_id, context, dedupe_key, next_attempt_at) values ($1, $2, $3::text::jsonb, $4, $5) on conflict (tenant_id, dedupe_key) do nothing returning id",
        [wf.id, e.id, json({ event: e.payload, outputs: {} }), `run:${e.id}`, now.toISOString()]);
      if (r.length) { started++; await meter(tdb, "workflow_runs"); }
    }
    await tdb.query("update bai_events set status = $2, processed_at = now() where id = $1", [e.id, wf ? "processed" : "ignored"]);
  }
  return started;
}

/** Executes one run step by step; each step commits on its own, so a failure never undoes earlier steps. */
export async function executeRun(db: Db, tenantId: string, runId: string, deps: AgentDeps): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const head = await withTenant(db, tenantId, (tdb) => maybeOne<{ workflow: string; status: string; attempts: number; time_zone: string; paused: boolean }>(tdb,
    "select r.workflow, r.status, r.attempts, t.time_zone, t.paused from bai_workflow_runs r cross join bai_tenants t where r.id = $1", [runId]));
  if (!head || head.paused || !["running", "retry_scheduled"].includes(head.status)) return head?.status ?? "missing";
  const wf = BY_ID.get(head.workflow);
  if (!wf) throw new PermanentError(`unknown workflow ${head.workflow}`);
  for (const [i, step] of wf.steps.entries()) {
    try {
      const done = await withTenant(db, tenantId, async (tdb) => {
        if ((await one<{ paused: boolean }>(tdb, "select paused from bai_tenants")).paused) return "paused";
        if (await maybeOne(tdb, "select 1 from bai_workflow_steps where run_id = $1 and step_key = $2", [runId, step.key])) return "already";
        const run = await one<{ context: { event: Record<string, unknown>; outputs: Outputs } }>(tdb, "select context from bai_workflow_runs where id = $1", [runId]);
        const state: RunState = { event: run.context.event, outputs: run.context.outputs, now, timeZone: head.time_zone };
        const input = await step.input(state, tdb);
        const agent = TOOLS.get(step.tool)!.agent;
        let status: "succeeded" | "skipped" = "succeeded"; let output: unknown;
        if ("skip" in input && typeof input.skip === "string") { status = "skipped"; output = { skipped: input.skip }; }
        else {
          const r = await runTool(tdb, deps, step.tool, input as Record<string, unknown>, runId);
          if (r.ran) output = r.output; else { status = "skipped"; output = { skipped: r.skipped }; }
        }
        await tdb.query("insert into bai_workflow_steps (run_id, step_key, agent_id, status, output, attempts) values ($1, $2, $3, $4, $5::text::jsonb, $6)",
          [runId, step.key, agent, status, json(output ?? {}), head.attempts + 1]);
        await tdb.query("update bai_workflow_runs set context = jsonb_set(context, array['outputs', $2::text], $3::text::jsonb) where id = $1", [runId, step.key, json(output ?? {})]);
        const next = wf.steps[i + 1];
        const to = next ? TOOLS.get(next.tool)!.agent : "business-manager";
        await tdb.query("insert into bai_agent_messages (run_id, from_agent, to_agent, kind, body) values ($1, $2, $3, $4, $5::text::jsonb)",
          [runId, agent, to, next ? "handoff" : "run_report", json({ step: step.key, status, output: summarise(output) })]);
        return "ok";
      });
      if (done === "paused") {
        await withTenant(db, tenantId, (tdb) => tdb.query("update bai_workflow_runs set status = 'paused' where id = $1", [runId]));
        return "paused";
      }
    } catch (err) {
      const e = errorDetails(err);
      const permanent = err instanceof PermanentError;
      return withTenant(db, tenantId, async (tdb) => {
        const attempts = head.attempts + 1;
        if (permanent || attempts >= MAX_ATTEMPTS) {
          await tdb.query("insert into bai_workflow_steps (run_id, step_key, agent_id, status, error, attempts) values ($1, $2, $3, 'failed', $4, $5) on conflict (run_id, step_key) do nothing",
            [runId, step.key, TOOLS.get(step.tool)?.agent ?? "unknown", e.message, attempts]);
          await tdb.query("update bai_workflow_runs set status = 'failed', attempts = $2, error = $3, finished_at = now() where id = $1", [runId, attempts, `${step.key}: ${e.message}`]);
          await tdb.query(`insert into bai_recommendations (agent_id, kind, title, rationale, dedupe_key) values ('business-manager', 'issue', $1, $2, $3) on conflict do nothing`,
            [`Workflow "${wf.description}" stopped at ${step.key}`, e.message, `run_failed:${runId}`]);
          await tenantAudit(tdb, { actor: "system:workflow", action: "workflow.failed", subjectType: "workflow_run", subjectId: runId, detail: { step: step.key, error: e.message } });
          return "failed";
        }
        const delay = Math.min(3600, 30 * 2 ** (attempts - 1));
        await tdb.query("update bai_workflow_runs set status = 'retry_scheduled', attempts = $2, error = $3, next_attempt_at = $4 where id = $1",
          [runId, attempts, `${step.key}: ${e.message}`, new Date(now.getTime() + delay * 1000).toISOString()]);
        return "retry_scheduled";
      });
    }
  }
  await withTenant(db, tenantId, (tdb) => tdb.query("update bai_workflow_runs set status = 'succeeded', finished_at = now(), error = null where id = $1", [runId]));
  return "succeeded";
}

function summarise(output: unknown): unknown {
  const s = JSON.stringify(output ?? {});
  return s.length <= 2000 ? output : { truncated: s.slice(0, 2000) };
}

/** One cycle for one tenant: schedules, events → runs, due runs. */
export async function processTenant(db: Db, tenantId: string, deps: AgentDeps): Promise<{ scheduled: string[]; started: number; runs: Record<string, number> }> {
  const now = deps.now?.() ?? new Date();
  const scheduled = await withTenant(db, tenantId, (tdb) => scheduleTenant(tdb, now));
  const runs: Record<string, number> = {};
  let started = 0;
  // Events emitted by one run (booking confirmed, job completed) start their workflow in the same cycle.
  for (let round = 0; round < 5; round++) {
    started += await withTenant(db, tenantId, (tdb) => startRuns(tdb, now));
    const due = await withTenant(db, tenantId, (tdb) => tdb.query<{ id: string }>(
      "select id from bai_workflow_runs where status in ('running','retry_scheduled') and next_attempt_at <= $1 order by created_at limit 50", [now.toISOString()]));
    if (due.length === 0) break;
    for (const r of due) {
      const status = await executeRun(db, tenantId, r.id, deps);
      runs[status] = (runs[status] ?? 0) + 1;
    }
  }
  return { scheduled, started, runs };
}

/** The Business AI cycle: every active tenant, each isolated from the others' failures. */
export async function businessAiCycle(db: Db, deps: AgentDeps, opts: { marketplace?: MarketplaceFeedClient } = {}): Promise<{ tenants: number; failures: { tenantId: string; error: string }[]; marketplace: Record<string, string> }> {
  const ids = await activeTenantIds(db);
  const failures: { tenantId: string; error: string }[] = [];
  const marketplace: Record<string, string> = {};
  for (const id of ids) {
    try {
      // Read the business's new marketplace requests and bookings first, so this cycle acts on them.
      if (opts.marketplace) marketplace[id] = (await syncMarketplace(db, opts.marketplace, id)).detail;
      await processTenant(db, id, deps);
    } catch (err) { failures.push({ tenantId: id, error: errorDetails(err).message }); }
  }
  return { tenants: ids.length, failures, marketplace };
}
