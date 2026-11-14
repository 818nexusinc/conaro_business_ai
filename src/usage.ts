import type { TenantDb } from "./tenancy.ts";
import { planFor } from "./catalog/plans.ts";

export type UsageMetric = "ai_calls" | "external_actions" | "workflow_runs";

export function usagePeriod(at = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/** Metered usage this month for a tenant. */
export async function usageThisMonth(tdb: TenantDb, at = new Date()): Promise<Record<string, number>> {
  const rows = await tdb.query<{ metric: string; quantity: number }>("select metric, quantity from bai_usage where period = $1", [usagePeriod(at)]);
  return Object.fromEntries(rows.map((r) => [r.metric, Number(r.quantity)]));
}

const LIMIT_KEYS: Partial<Record<UsageMetric, "aiCallsPerMonth" | "externalActionsPerMonth">> = {
  ai_calls: "aiCallsPerMonth", external_actions: "externalActionsPerMonth",
};

/** Records usage; returns false (and records nothing) when the plan's monthly limit is reached. */
export async function meter(tdb: TenantDb, metric: UsageMetric, quantity = 1, at = new Date()): Promise<boolean> {
  const key = LIMIT_KEYS[metric];
  if (key) {
    const plan = (await tdb.query<{ plan: string }>("select plan from bai_subscriptions"))[0]?.plan;
    const limit = plan ? planFor(plan).limits[key] : 0;
    const used = (await usageThisMonth(tdb, at))[metric] ?? 0;
    if (used + quantity > limit) return false;
  }
  await tdb.query(
    `insert into bai_usage (period, metric, quantity) values ($1, $2, $3)
     on conflict (tenant_id, period, metric) do update set quantity = bai_usage.quantity + excluded.quantity`,
    [usagePeriod(at), metric, quantity]);
  return true;
}
