import { maybeOne, one } from "./shared/db.ts";
import { PermanentError } from "./shared/errors.ts";
import type { TenantDb } from "./tenancy.ts";
import type { ActionEffect } from "./gateway.ts";
import type { BusinessActionType } from "./catalog/actions.ts";
import { emitEvent } from "./events.ts";
import { tenantAudit } from "./audit.ts";

/**
 * Changes to the business's own records that follow when an action executes
 * (immediately under a rule, or later after the owner approves). The external
 * part (the message to the customer) is simulated by the gateway.
 */
export const EFFECTS: Partial<Record<BusinessActionType, ActionEffect>> = {
  "quote.send": async (tdb, p) => {
    await tdb.query("update bai_quotes set status = 'sent', sent_at = now() where id = $1 and status in ('draft','pending_approval')", [p.quoteId]);
    if (p.leadId) await tdb.query("update bai_leads set status = 'quoted', updated_at = now() where id = $1 and status in ('new','qualified')", [p.leadId]);
  },
  "booking.confirm": async (tdb, p) => {
    const b = await one<{ status: string; employee_id: string | null; starts_at: string; ends_at: string }>(tdb, "select status, employee_id, starts_at, ends_at from bai_bookings where id = $1", [p.bookingId]);
    if (b.status === "confirmed") return;
    if (b.status !== "requested") throw new PermanentError(`booking is ${b.status}`);
    const employeeId = b.employee_id ?? (p.employeeId as string);
    // Re-validate at the moment of confirmation: the slot may have been taken since the agent checked it.
    const clash = await maybeOne(tdb,
      `select 1 from bai_bookings where id <> $1 and employee_id = $2 and status = 'confirmed' and starts_at < $4 and ends_at > $3`,
      [p.bookingId, employeeId, b.starts_at, b.ends_at]);
    if (clash) throw new PermanentError("the time slot is no longer free; choose another time");
    await tdb.query("update bai_bookings set status = 'confirmed', employee_id = $2, confirmed_at = now() where id = $1", [p.bookingId, employeeId]);
    await emitEvent(tdb, "booking.confirmed", { bookingId: p.bookingId }, `booking.confirmed:${String(p.bookingId)}`);
  },
  "booking.reschedule": async (tdb, p) => {
    await tdb.query("update bai_bookings set starts_at = $2, ends_at = $3, reminder_sent_at = null where id = $1 and status in ('requested','confirmed')", [p.bookingId, p.newStartsAt, p.newEndsAt]);
  },
  "reminder.send": async (tdb, p) => {
    await tdb.query("update bai_bookings set reminder_sent_at = now() where id = $1", [p.bookingId]);
  },
  "invoice.issue": async (tdb, p) => {
    const days = (await tdb.query<{ d: number }>("select coalesce((policy->>'invoice_due_days')::int, 14) d from bai_settings"))[0]?.d ?? 14;
    await tdb.query("update bai_invoices set status = 'issued', issued_at = now(), due_on = (now() + make_interval(days => $2))::date where id = $1 and status = 'draft'", [p.invoiceId, days]);
  },
  "payment.reminder": async (tdb, p) => {
    await tdb.query("update bai_invoices set last_reminder_at = now() where id = $1", [p.invoiceId]);
  },
  "pricing.change": async (tdb, p) => {
    await tdb.query("update bai_services set price_cents = $2, updated_at = now() where id = $1", [p.serviceId, p.priceCents]);
    await tenantAudit(tdb, { actor: "system:effects", action: "pricing.changed", subjectType: "service", subjectId: String(p.serviceId), detail: { priceCents: p.priceCents } });
  },
};

/** The customer accepts a quote (from the portal on their behalf, or a marketplace callback). */
export async function acceptQuote(tdb: TenantDb, quoteId: string, startsAt: string, actor: string): Promise<void> {
  const q = await one<{ status: string; lead_id: string | null; valid_until: string | null }>(tdb, "select status, lead_id, valid_until from bai_quotes where id = $1", [quoteId]);
  if (q.status !== "sent") throw new PermanentError(`quote is ${q.status}; only a sent quote can be accepted`);
  if (q.valid_until && new Date(q.valid_until) < new Date(new Date().toISOString().slice(0, 10))) throw new PermanentError("quote has expired");
  await tdb.query("update bai_quotes set status = 'accepted', decided_at = now() where id = $1", [quoteId]);
  if (q.lead_id) await tdb.query("update bai_leads set status = 'won', updated_at = now() where id = $1", [q.lead_id]);
  await tenantAudit(tdb, { actor, action: "quote.accepted", subjectType: "quote", subjectId: quoteId });
  await emitEvent(tdb, "quote.accepted", { quoteId, startsAt }, `quote.accepted:${quoteId}`);
}
