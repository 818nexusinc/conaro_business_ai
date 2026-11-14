import { json } from "./shared/db.ts";
import type { TenantDb } from "./tenancy.ts";

export const EVENT_TYPES = [
  "lead.received", "quote.accepted", "booking.confirmed", "job.completed", "payment.received",
  "capacity.unused", "revenue.below_target", "schedule.hourly", "schedule.daily", "schedule.weekly", "schedule.monthly",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Records a business event once (dedupe key per tenant). Workflows pick it up on the next cycle. */
export async function emitEvent(tdb: TenantDb, type: EventType, payload: Record<string, unknown>, dedupeKey: string): Promise<boolean> {
  const rows = await tdb.query("insert into bai_events (type, payload, dedupe_key) values ($1, $2::text::jsonb, $3) on conflict (tenant_id, dedupe_key) do nothing returning id",
    [type, json(payload), dedupeKey]);
  return rows.length > 0;
}
