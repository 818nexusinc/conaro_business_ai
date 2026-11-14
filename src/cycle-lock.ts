import { randomBytes } from "node:crypto";
import type { Db } from "./shared/db.ts";
import type { AgentDeps } from "./agent-context.ts";
import type { MarketplaceFeedClient } from "./interop/marketplace.ts";
import { businessAiCycle } from "./workflows.ts";

const LEASE_MINUTES = 10;

/**
 * Runs one agents' cycle unless another instance is already running one. Scheduled triggers can
 * overlap or be delivered twice; every step is idempotent anyway, and this lease avoids doing the
 * work twice at the same time. A lease left by a crashed instance expires after 10 minutes.
 */
export async function runLockedCycle(db: Db, deps: AgentDeps, opts: { marketplace?: MarketplaceFeedClient } = {}):
  Promise<{ ran: false; reason: string } | ({ ran: true } & Awaited<ReturnType<typeof businessAiCycle>>)> {
  const holder = randomBytes(8).toString("hex");
  const got = await db.query(
    `update bai_cycle_lock set holder = $1, locked_until = now() + make_interval(mins => $2)
     where id = 1 and locked_until < now() returning id`, [holder, LEASE_MINUTES]);
  if (!got.length) return { ran: false, reason: "another cycle is running" };
  try {
    return { ran: true, ...(await businessAiCycle(db, deps, opts)) };
  } finally {
    await db.query("update bai_cycle_lock set locked_until = '-infinity', holder = null where id = 1 and holder = $1", [holder]);
  }
}
