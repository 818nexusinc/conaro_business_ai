import type { ReasoningPort } from "./shared/reasoning.ts";
import { TenantGateway } from "./gateway.ts";
import { EFFECTS } from "./effects.ts";
import type { AgentDeps } from "./agent-context.ts";

export interface BusinessAi { gateway: TenantGateway; deps: AgentDeps }

/** Wires the Business AI runtime. There are no external executors: every external effect is simulated. */
export function createBusinessAi(opts: { reasoning: ReasoningPort; publicBaseUrl: string; linkSecret: string; now?: () => Date }): BusinessAi {
  if (opts.linkSecret.length < 32) throw new Error("BAI_UNSUBSCRIBE_SECRET must be at least 32 characters");
  const gateway = new TenantGateway(EFFECTS);
  return { gateway, deps: { gateway, reasoning: opts.reasoning, publicBaseUrl: opts.publicBaseUrl, linkSecret: opts.linkSecret, ...(opts.now ? { now: opts.now } : {}) } };
}

export { withTenant } from "./tenancy.ts";
export { businessAiCycle, processTenant } from "./workflows.ts";
