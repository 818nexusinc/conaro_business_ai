import { json, maybeOne, one } from "./shared/db.ts";
import { PermanentError } from "./shared/errors.ts";
import { validateCommercialMessage } from "./shared/casl-message.ts";
import type { TenantDb } from "./tenancy.ts";
import { nextRef } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";
import { actionPolicy, isBusinessAction, type BusinessActionType } from "./catalog/actions.ts";
import { AGENT_BY_ID } from "./catalog/agents.ts";
import { isEntitled } from "./catalog/plans.ts";
import { getPolicy, type Policy } from "./settings.ts";
import { checkCustomerConsent } from "./consent.ts";
import { meter } from "./usage.ts";

export interface BusinessActionRequest {
  agentId: string;
  actionType: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  /** Stable key for this logical action; the same key never runs twice. */
  idempotencyKey: string;
  runId?: string;
  /** Customers who would receive a message (CASL is checked for commercial actions). */
  recipients?: { customerId: string; email: string | null }[];
}

export type BusinessActionOutcome =
  | { status: "done"; actionId: string }
  | { status: "simulated"; actionId: string }
  | { status: "approval_pending"; actionId: string; approvalId: string; approvalRef: string; why: string }
  | { status: "approved_for_person"; actionId: string }
  | { status: "blocked"; actionId?: string; reason: string }
  | { status: "duplicate"; actionId: string; previousStatus: string };

/** Record changes applied when an action actually executes (now, or after approval). */
export type ActionEffect = (tdb: TenantDb, payload: Record<string, unknown>, ctx: { actionId: string; simulated: boolean }) => Promise<void>;

/** Level-2 rules: may this payload run without the owner? */
type Rule = (p: Record<string, unknown>, policy: Policy, tdb: TenantDb) => Promise<string | null> | string | null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

const RULES: Partial<Record<BusinessActionType, Rule>> = {
  "booking.confirm": (p, pol) => !pol.auto_confirm_bookings ? "automatic booking confirmation is off"
    : p.availabilityValidated !== true ? "availability was not validated" : null,
  "booking.reschedule": (p, pol) => {
    if (!pol.auto_reschedule) return "automatic rescheduling is off";
    const hours = (new Date(String(p.currentStartsAt)).getTime() - Date.now()) / 3_600_000;
    return hours >= pol.min_reschedule_notice_hours ? null : `less than ${pol.min_reschedule_notice_hours} hours' notice`;
  },
  "quote.send": (p, pol) => {
    if (!pol.auto_send_quotes) return "automatic quote sending is off";
    if (!(num(p.totalCents) <= pol.max_auto_quote_cents)) return `total above the automatic limit (${pol.max_auto_quote_cents / 100} CAD)`;
    if (!(num(p.discountPct ?? 0) <= pol.max_discount_pct)) return "discount above the configured maximum";
    return null;
  },
  "discount.offer": (p, pol) => num(p.discountPct) > 0 && num(p.discountPct) <= pol.max_discount_pct ? null : "discount outside the configured maximum",
  "marketing.send": async (p, pol, tdb) => {
    if (!pol.marketing_autosend || pol.campaign_mode !== "autonomous") return "autonomous marketing is off";
    const spent = await tdb.query<{ s: number }>(
      `select coalesce(sum((payload->>'costCents')::int), 0)::int s from bai_actions
       where action_type = 'marketing.send' and status in ('simulated','done') and date_trunc('month', created_at) = date_trunc('month', now())`);
    const cost = num(p.costCents ?? 0);
    return (spent[0]?.s ?? 0) + cost <= pol.monthly_marketing_budget_cents ? null : "over the monthly marketing budget";
  },
  "message.follow_up": (_p, pol) => (pol.auto_follow_up ? null : "automatic follow-ups are off"),
  "feedback.request": (_p, pol) => (pol.auto_feedback_requests ? null : "automatic feedback requests are off"),
  "invoice.issue": (_p, pol) => (pol.auto_issue_invoices ? null : "automatic invoice issuing is off"),
  "payment.reminder": (_p, pol) => (pol.auto_payment_reminders ? null : "automatic payment reminders are off"),
  "purchase.supplies": (p, pol) => (num(p.amountCents) <= pol.supplies_limit_cents ? null : "above the supplies spending limit"),
  "refund.issue": (p, pol) => (num(p.amountCents) <= pol.refund_limit_cents ? null : "above the refund limit"),
};

/** Level-1 external actions that still respect an owner switch. */
const L1_SWITCHES: Partial<Record<BusinessActionType, (p: Record<string, unknown>, pol: Policy) => string | null>> = {
  "reminder.send": (_p, pol) => (pol.send_appointment_reminders ? null : "appointment reminders are off"),
  "social.publish": (p, pol) => (p.ownerApproved === true || pol.social_autopublish ? null : "post not approved and autopublish is off"),
};

/**
 * The only path from a Business AI agent to any effect. Nothing here calls an
 * external service: there are no executors in this build, so every external
 * effect is recorded as SIMULATED. Adding a real executor needs the owner's
 * explicit approval and must go through src/integrations/gateway.ts (CLAUDE.md).
 */
export class TenantGateway {
  constructor(private readonly effects: Partial<Record<BusinessActionType, ActionEffect>> = {}) {}

  async submit(tdb: TenantDb, req: BusinessActionRequest): Promise<BusinessActionOutcome> {
    if (!isBusinessAction(req.actionType)) return { status: "blocked", reason: `unknown action ${req.actionType}` };
    const type = req.actionType;
    const policyDef = actionPolicy(type);
    const prior = await maybeOne<{ id: string; status: string }>(tdb, "select id, status from bai_actions where idempotency_key = $1", [req.idempotencyKey]);
    if (prior) return { status: "duplicate", actionId: prior.id, previousStatus: prior.status };

    const block = async (reason: string): Promise<BusinessActionOutcome> => {
      const id = await this.record(tdb, req, type, "blocked", reason);
      return { status: "blocked", actionId: id, reason };
    };

    const tenant = await one<{ paused: boolean; status: string }>(tdb, "select paused, status from bai_tenants");
    if (tenant.paused) return block("all agents are paused by the owner");
    if (tenant.status === "suspended" || tenant.status === "cancelled") return block(`workspace is ${tenant.status}`);
    const def = AGENT_BY_ID.get(req.agentId);
    if (!def || def.status !== "operational") return block(`agent ${req.agentId} is not available`);
    if (!def.actions.includes(type)) return block(`${def.name} may not perform ${type}`);
    const agent = await maybeOne<{ enabled: boolean; autonomy: string }>(tdb, "select enabled, autonomy from bai_agents where agent_id = $1", [req.agentId]);
    if (!agent?.enabled) return block(`${def.name} is switched off`);
    const sub = await one<{ plan: string; addons: string[]; status: string }>(tdb, "select plan, addons, status from bai_subscriptions");
    if (sub.status === "cancelled") return block("subscription cancelled");
    if (!isEntitled(sub.plan, sub.addons, req.agentId)) return block(`${def.name} is not in the current plan`);

    const pol = await getPolicy(tdb);
    let recipients = req.recipients ?? [];
    if (policyDef.commercial) {
      const content = validateCommercialMessage(req.payload.message);
      if (!content.ok) return block(`message is missing required content: ${content.problems.join("; ")}`);
      const eligible: typeof recipients = [];
      for (const r of recipients) if (r.email && (await checkCustomerConsent(tdb, r.email)).allowed) eligible.push(r);
      if (eligible.length === 0) return block("no recipient has valid consent (CASL)");
      recipients = eligible;
    }

    // Decide: run now, ask the owner, or refuse.
    let why: string | null = null;
    if (policyDef.level === 3) why = "level 3: owner approval is always required";
    else if (policyDef.external) {
      if (agent.autonomy === "draft_only") return block(`${def.name} is in draft-only mode`);
      if (policyDef.level === 2) {
        const ruleFail = await RULES[type]?.(req.payload, pol, tdb);
        if (agent.autonomy === "approval") why = "agent set to ask before acting";
        else if (ruleFail) why = ruleFail;
      } else {
        if (agent.autonomy === "approval") why = "agent set to ask before acting";
        const off = L1_SWITCHES[type]?.(req.payload, pol);
        if (off) {
          if (type === "reminder.send") return block(off);
          why = off;
        }
      }
    }
    if (why && agent.autonomy === "draft_only") return block(`${def.name} is in draft-only mode`);

    const payload = { ...req.payload, ...(recipients.length ? { recipients } : {}) };
    if (why) return this.fileApproval(tdb, { ...req, payload }, type, why);
    return this.execute(tdb, { ...req, payload }, type, null);
  }

  /** Runs an action the owner approved. */
  async executeApproved(tdb: TenantDb, approvalId: string): Promise<BusinessActionOutcome> {
    const ap = await maybeOne<{ id: string; status: string; action_type: string; payload: { request: BusinessActionRequest } }>(tdb,
      "select id, status, action_type, payload from bai_approvals where id = $1", [approvalId]);
    if (!ap) throw new PermanentError("approval not found");
    if (ap.status !== "approved") throw new PermanentError(`approval is ${ap.status}`);
    const tenant = await one<{ paused: boolean }>(tdb, "select paused from bai_tenants");
    if (tenant.paused) return { status: "blocked", reason: "all agents are paused by the owner" };
    const req = ap.payload.request;
    const outcome = await this.execute(tdb, req, ap.action_type as BusinessActionType, ap.id);
    await tdb.query("update bai_approvals set status = 'executed' where id = $1", [ap.id]);
    await tdb.query("insert into bai_approval_events (approval_id, event, actor) values ($1, 'executed', 'system:gateway')", [ap.id]);
    return outcome;
  }

  private async execute(tdb: TenantDb, req: BusinessActionRequest, type: BusinessActionType, approvalId: string | null): Promise<BusinessActionOutcome> {
    const def = actionPolicy(type);
    if (def.personOnly) {
      const id = await this.upsert(tdb, req, type, "approved_for_person", "approved; a person must carry this out", approvalId);
      await tenantAudit(tdb, { actor: `agent:${req.agentId}`, action: "action.approved_for_person", subjectType: "action", subjectId: id, detail: { type } });
      return { status: "approved_for_person", actionId: id };
    }
    if (def.external && !(await meter(tdb, "external_actions"))) {
      const id = await this.upsert(tdb, req, type, "blocked", "monthly action limit of the plan reached", approvalId);
      return { status: "blocked", actionId: id, reason: "monthly action limit of the plan reached" };
    }
    const status = def.external ? "simulated" : "done";
    const id = await this.upsert(tdb, req, type, status, def.external ? "SIMULATION: no external executor is connected" : null, approvalId);
    await this.effects[type]?.(tdb, req.payload, { actionId: id, simulated: def.external });
    const msg = req.payload.message as { body?: string; bodyText?: string; channel?: string; customerId?: string } | undefined;
    if (def.external && msg && (msg.body || msg.bodyText)) {
      const targets = (req.payload.recipients as { customerId: string }[] | undefined)?.map((r) => r.customerId) ?? [msg.customerId ?? null];
      for (const c of targets) {
        await tdb.query("insert into bai_messages (customer_id, lead_id, direction, channel, body, simulated, action_id) values ($1, $2, 'outbound', $3, $4, true, $5)",
          [c, (req.payload.leadId as string | undefined) ?? null, msg.channel ?? "email", msg.body ?? msg.bodyText, id]);
      }
    }
    await tenantAudit(tdb, { actor: `agent:${req.agentId}`, action: `action.${status}`, subjectType: "action", subjectId: id, detail: { type, approvalId } });
    return { status, actionId: id } as BusinessActionOutcome;
  }

  private async fileApproval(tdb: TenantDb, req: BusinessActionRequest, type: BusinessActionType, why: string): Promise<BusinessActionOutcome> {
    const ref = await nextRef(tdb, "approval", "AP");
    const level = actionPolicy(type).level;
    const ap = await one<{ id: string }>(tdb,
      `insert into bai_approvals (ref, action_type, level, title, summary, payload, idempotency_key, requested_by_agent, expires_at)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, now() + interval '14 days') returning id`,
      [ref, type, level, req.title, `${req.summary ?? ""}${req.summary ? " — " : ""}Why approval: ${why}`, json({ request: req }), req.idempotencyKey, req.agentId]);
    await tdb.query("insert into bai_approval_events (approval_id, event, actor, note) values ($1, 'requested', $2, $3)", [ap.id, `agent:${req.agentId}`, why]);
    const id = await this.record(tdb, req, type, "approval_pending", why, ap.id);
    await tenantAudit(tdb, { actor: `agent:${req.agentId}`, action: "approval.requested", subjectType: "approval", subjectId: ap.id, detail: { type, why } });
    return { status: "approval_pending", actionId: id, approvalId: ap.id, approvalRef: ref, why };
  }

  private async record(tdb: TenantDb, req: BusinessActionRequest, type: BusinessActionType, status: string, reason: string | null, approvalId: string | null = null): Promise<string> {
    const row = await one<{ id: string }>(tdb,
      `insert into bai_actions (agent_id, action_type, level, title, payload, idempotency_key, status, reason, run_id, approval_id)
       values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9, $10) returning id`,
      [req.agentId, type, actionPolicy(type).level, req.title, json(req.payload), req.idempotencyKey, status, reason, req.runId ?? null, approvalId]);
    if (status === "blocked") await tenantAudit(tdb, { actor: `agent:${req.agentId}`, action: "action.blocked", subjectType: "action", subjectId: row.id, detail: { type, reason } });
    return row.id;
  }

  private async upsert(tdb: TenantDb, req: BusinessActionRequest, type: BusinessActionType, status: string, reason: string | null, approvalId: string | null): Promise<string> {
    const existing = await maybeOne<{ id: string }>(tdb, "select id from bai_actions where idempotency_key = $1", [req.idempotencyKey]);
    if (existing) {
      await tdb.query("update bai_actions set status = $2, reason = $3, updated_at = now() where id = $1", [existing.id, status, reason]);
      return existing.id;
    }
    return this.record(tdb, req, type, status, reason, approvalId);
  }
}

/** Owner or manager decision on an approval. Managers cannot approve level 3. */
export async function decideApproval(tdb: TenantDb, gateway: TenantGateway, input: {
  approvalId: string; userId: string; role: string; decision: "approve" | "reject"; note?: string;
}): Promise<BusinessActionOutcome | { status: "rejected" }> {
  const ap = await maybeOne<{ id: string; status: string; level: number; expires_at: string; idempotency_key: string }>(tdb,
    "select id, status, level, expires_at, idempotency_key from bai_approvals where id = $1", [input.approvalId]);
  if (!ap) throw new PermanentError("approval not found");
  if (ap.status !== "pending") throw new PermanentError(`approval is already ${ap.status}`);
  if (new Date(ap.expires_at) < new Date()) throw new PermanentError("approval has expired");
  if (!(input.role === "owner" || (input.role === "manager" && ap.level < 3))) throw new PermanentError("only the owner can decide this");
  const status = input.decision === "approve" ? "approved" : "rejected";
  await tdb.query("update bai_approvals set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1", [ap.id, status, input.userId, input.note ?? null]);
  await tdb.query("insert into bai_approval_events (approval_id, event, actor, note) values ($1, $2, $3, $4)", [ap.id, status, `user:${input.userId}`, input.note ?? null]);
  await tenantAudit(tdb, { actor: `user:${input.userId}`, action: `approval.${status}`, subjectType: "approval", subjectId: ap.id });
  if (status === "rejected") {
    await tdb.query("update bai_actions set status = 'rejected', updated_at = now() where idempotency_key = $1", [ap.idempotency_key]);
    return { status: "rejected" };
  }
  return gateway.executeApproved(tdb, ap.id);
}
