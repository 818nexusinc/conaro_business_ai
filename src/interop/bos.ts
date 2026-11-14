import type { Db } from "../shared/db.ts";
import { one } from "../shared/db.ts";

/**
 * What the CONARO operating system may read about Business AI: counts only. No business name, no
 * customer, no financial figure of any business. Served at GET /api/link/v1/summary, signed with
 * BAI_BOS_LINK_SECRET (a key separate from the marketplace's, so neither peer can act as the other).
 *
 * Demo workspaces (is_demo) are left out.
 * This is a system query across workspaces (the documented exception to tenant-only access), and it
 * returns aggregates only.
 */
export interface BusinessAiSummary {
  version: 1;
  generatedAt: string;
  app: "conaro-business-ai";
  mode: "simulation";
  workspaces: { total: number; paused: number; linkedToMarketplace: number; byStatus: Record<string, number>; byPlan: Record<string, number>; byIndustry: Record<string, number> };
  last24h: { workflowRuns: number; failedRuns: number; actionsDone: number; actionsSimulated: number; actionsBlocked: number };
  waiting: { approvals: number; openIssues: number };
  marketplaceSync: { ok: number; failing: number };
}

const group = async (db: Db, sql: string): Promise<Record<string, number>> =>
  Object.fromEntries((await db.query<{ k: string; n: number }>(sql)).map((r) => [r.k, Number(r.n)]));

export async function buildSummary(db: Db, now = new Date()): Promise<BusinessAiSummary> {
  const w = await one<{ total: number; paused: number; linked: number }>(db,
    "select count(*)::int total, count(*) filter (where paused)::int paused, count(*) filter (where marketplace_provider_ref is not null)::int linked from bai_tenants where status <> 'cancelled' and not is_demo");
  const a = await one<{ runs: number; failed: number; done: number; simulated: number; blocked: number }>(db,
    `select (select count(*) from bai_workflow_runs where tenant_id in (select id from bai_tenants where not is_demo) and created_at > $1::timestamptz - interval '1 day')::int runs,
            (select count(*) from bai_workflow_runs where tenant_id in (select id from bai_tenants where not is_demo) and status = 'failed' and created_at > $1::timestamptz - interval '1 day')::int failed,
            count(*) filter (where status = 'done')::int done, count(*) filter (where status = 'simulated')::int simulated, count(*) filter (where status = 'blocked')::int blocked
     from bai_actions where tenant_id in (select id from bai_tenants where not is_demo) and created_at > $1::timestamptz - interval '1 day'`, [now.toISOString()]);
  const waiting = await one<{ approvals: number; issues: number }>(db,
    "select (select count(*) from bai_approvals where tenant_id in (select id from bai_tenants where not is_demo) and status = 'pending')::int approvals, (select count(*) from bai_recommendations where tenant_id in (select id from bai_tenants where not is_demo) and status = 'open' and kind = 'issue')::int issues");
  const sync = await one<{ ok: number; failing: number }>(db,
    "select count(*) filter (where last_error is null and last_ok_at is not null)::int ok, count(*) filter (where last_error is not null)::int failing from bai_sync_state where tenant_id in (select id from bai_tenants where not is_demo) and source = 'conaro-marketplace'");
  return {
    version: 1, generatedAt: now.toISOString(), app: "conaro-business-ai", mode: "simulation",
    workspaces: {
      total: w.total, paused: w.paused, linkedToMarketplace: w.linked,
      byStatus: await group(db, "select status k, count(*) n from bai_tenants where not is_demo group by 1"),
      byPlan: await group(db, "select plan k, count(*) n from bai_subscriptions where tenant_id in (select id from bai_tenants where not is_demo) group by 1"),
      byIndustry: await group(db, "select industry k, count(*) n from bai_tenants where status <> 'cancelled' and not is_demo group by 1"),
    },
    last24h: { workflowRuns: a.runs, failedRuns: a.failed, actionsDone: a.done, actionsSimulated: a.simulated, actionsBlocked: a.blocked },
    waiting: { approvals: waiting.approvals, openIssues: waiting.issues },
    marketplaceSync: { ok: sync.ok, failing: sync.failing },
  };
}
