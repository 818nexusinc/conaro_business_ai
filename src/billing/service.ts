/**
 * Billing state from Stripe webhooks. Every event is recorded once (idempotent); a business is identified by the
 * client_reference_id / metadata we set when creating its Checkout Session, never by anything the event body
 * could choose freely for another business.
 */
import type { Db } from "../shared/db.ts";
import { json, maybeOne } from "../shared/db.ts";
import { withTenant } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";
import { PLANS } from "../catalog/plans.ts";

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stripe subscription status → our subscription status and billing status. */
export function mapStatus(s: string): { status: "trial" | "active" | "past_due" | "cancelled"; billing: string } {
  switch (s) {
    case "active": return { status: "active", billing: "active" };
    case "trialing": return { status: "trial", billing: "trialing" };
    case "past_due": case "unpaid": return { status: "past_due", billing: s };
    case "canceled": case "incomplete_expired": return { status: "cancelled", billing: s };
    default: return { status: "trial", billing: s }; // incomplete, paused
  }
}

async function setTenantBilling(db: Db, tenantId: string, patch: { status?: string; billing: string; plan?: string | null }, event: string, detail: Record<string, unknown>): Promise<void> {
  await withTenant(db, tenantId, async (t) => {
    const plan = patch.plan && PLANS.some((p) => p.id === patch.plan) ? patch.plan : null;
    await t.query(`update bai_subscriptions set billing_status = $1, status = coalesce($2, status), plan = coalesce($3, plan), updated_at = now()`, [patch.billing, patch.status ?? null, plan]);
    await t.query("insert into bai_subscription_events (event, detail, actor) values ($1, $2::text::jsonb, 'system:stripe')", [event, json(detail)]);
    await tenantAudit(t, { actor: "system:stripe", action: `billing.${event}`, subjectType: "subscription", subjectId: tenantId, detail });
  });
}

/** Applies one verified event. Returns what happened (stored with the event). */
export async function applyStripeEvent(db: Db, e: { id: string; type: string; livemode: boolean; data: { object: Obj } }, opts: { allowLive: boolean }): Promise<string> {
  const seen = await maybeOne(db, "select 1 from bai_billing_events where event_id = $1", [e.id]);
  if (seen) return "duplicate";
  let tenantId: string | null = null; let outcome = "ignored";
  const o = e.data.object;
  if (e.livemode && !opts.allowLive) outcome = "refused: live mode not approved";
  else if (e.type === "checkout.session.completed") {
    const ref = str(o.client_reference_id) ?? str((o.metadata as Obj | undefined)?.tenant_id);
    if (ref && UUID.test(ref) && await maybeOne(db, "select 1 from bai_tenants where id = $1", [ref])) {
      tenantId = ref;
      const plan = str((o.metadata as Obj | undefined)?.plan);
      await db.query(`insert into bai_billing_accounts (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_status, plan, livemode, updated_at) values ($1, $2, $3, 'active', $4, $5, now())
        on conflict (tenant_id) do update set stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id, stripe_status = 'active', plan = excluded.plan, livemode = excluded.livemode, updated_at = now()`,
        [ref, str(o.customer), str(o.subscription), plan, e.livemode]);
      await setTenantBilling(db, ref, { status: "active", billing: "active", plan }, "checkout_completed", { session: str(o.id), subscription: str(o.subscription), livemode: e.livemode });
      outcome = "subscription started";
    } else outcome = "ignored: unknown business";
  } else if (e.type === "customer.subscription.updated" || e.type === "customer.subscription.deleted") {
    const acct = await maybeOne<{ tenant_id: string }>(db, "select tenant_id from bai_billing_accounts where stripe_subscription_id = $1 or stripe_customer_id = $2", [str(o.id), str(o.customer)]);
    if (acct) {
      tenantId = acct.tenant_id;
      const st = e.type === "customer.subscription.deleted" ? "canceled" : str(o.status) ?? "active";
      const m = mapStatus(st);
      await db.query("update bai_billing_accounts set stripe_status = $2, updated_at = now() where tenant_id = $1", [acct.tenant_id, st]);
      await setTenantBilling(db, acct.tenant_id, { status: m.status, billing: m.billing }, "subscription_" + (e.type.endsWith("deleted") ? "ended" : "updated"), { status: st });
      outcome = `status ${st}`;
    } else outcome = "ignored: unknown subscription";
  } else if (e.type === "invoice.paid" || e.type === "invoice.payment_failed") {
    const acct = await maybeOne<{ tenant_id: string }>(db, "select tenant_id from bai_billing_accounts where stripe_customer_id = $1", [str(o.customer)]);
    if (acct) {
      tenantId = acct.tenant_id;
      const failed = e.type === "invoice.payment_failed";
      await setTenantBilling(db, acct.tenant_id, failed ? { status: "past_due", billing: "payment_failed" } : { billing: "active" }, failed ? "payment_failed" : "invoice_paid", { invoice: str(o.id) });
      outcome = failed ? "payment failed" : "invoice paid";
    } else outcome = "ignored: unknown customer";
  }
  await db.query("insert into bai_billing_events (event_id, type, livemode, tenant_id, outcome) values ($1, $2, $3, $4, $5) on conflict (event_id) do nothing", [e.id, e.type, e.livemode, tenantId, outcome]);
  return outcome;
}

export const billingAccount = (db: Db, tenantId: string) =>
  maybeOne<{ stripe_customer_id: string | null; stripe_status: string | null; plan: string | null }>(db, "select stripe_customer_id, stripe_status, plan from bai_billing_accounts where tenant_id = $1", [tenantId]);
