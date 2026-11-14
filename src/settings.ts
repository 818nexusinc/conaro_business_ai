import { z } from "zod";
import { json, maybeOne } from "./shared/db.ts";
import type { TenantDb } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";

/**
 * Business-wide operating policy. Every level-2 rule is OFF until the owner
 * turns it on, and every money limit starts at zero: out of the box nothing
 * goes to a customer or spends money without the owner's approval.
 */
export const PolicySchema = z.object({
  auto_confirm_bookings: z.boolean().default(false),
  auto_reschedule: z.boolean().default(false),
  min_reschedule_notice_hours: z.number().int().min(0).max(720).default(24),
  auto_send_quotes: z.boolean().default(false),
  max_auto_quote_cents: z.number().int().min(0).default(0),
  max_discount_pct: z.number().min(0).max(100).default(0),
  marketing_autosend: z.boolean().default(false),
  campaign_mode: z.enum(["draft_only", "approval", "autonomous"]).default("approval"),
  monthly_marketing_budget_cents: z.number().int().min(0).default(0),
  auto_follow_up: z.boolean().default(false),
  auto_feedback_requests: z.boolean().default(false),
  auto_issue_invoices: z.boolean().default(false),
  auto_payment_reminders: z.boolean().default(false),
  payment_reminder_days: z.number().int().min(1).max(90).default(7),
  supplies_limit_cents: z.number().int().min(0).default(0),
  refund_limit_cents: z.number().int().min(0).default(0),
  social_autopublish: z.boolean().default(false),
  send_appointment_reminders: z.boolean().default(true),
  reminder_hours_before: z.number().int().min(1).max(168).default(24),
  travel_buffer_minutes: z.number().int().min(0).max(240).default(30),
  quote_valid_days: z.number().int().min(1).max(365).default(14),
  invoice_due_days: z.number().int().min(0).max(120).default(14),
  /** Owner's own estimate of minutes a person would spend per action type (for the value report). Empty = not estimated. */
  minutes_saved: z.record(z.string(), z.number().min(0).max(600)).default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

export async function getPolicy(tdb: TenantDb): Promise<Policy> {
  const row = await maybeOne<{ policy: unknown }>(tdb, "select policy from bai_settings");
  return PolicySchema.parse(row?.policy ?? {});
}

export async function updatePolicy(tdb: TenantDb, patch: Partial<Policy>, actor: string): Promise<Policy> {
  const current = await getPolicy(tdb);
  const next = PolicySchema.parse({ ...current, ...patch });
  await tdb.query(
    `insert into bai_settings (policy, updated_by) values ($1::text::jsonb, $2)
     on conflict (tenant_id) do update set policy = excluded.policy, updated_by = excluded.updated_by, updated_at = now()`,
    [json(next), actor],
  );
  const changed = Object.keys(patch).filter((k) => JSON.stringify((current as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k]));
  await tenantAudit(tdb, { actor, action: "policy.updated", subjectType: "settings", detail: { changed } });
  return next;
}
