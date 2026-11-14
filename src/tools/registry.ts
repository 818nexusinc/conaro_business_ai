import { PermanentError } from "../shared/errors.ts";
import type { TenantDb } from "../tenancy.ts";
import type { Scope } from "../catalog/agents.ts";
import { AgentContext, type AgentDeps } from "../agent-context.ts";

export interface ToolDef<I = Record<string, unknown>, O = unknown> {
  name: string;
  agent: string;
  /** Data the tool reads; the agent must hold every scope. */
  scopes: Scope[];
  description: string;
  run(ctx: AgentContext, input: I): Promise<O>;
}

export const TOOLS = new Map<string, ToolDef>();

export function tool<I extends Record<string, unknown>, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (TOOLS.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
  TOOLS.set(def.name, def as unknown as ToolDef);
  return def;
}

export type ToolResult = { ran: true; output: unknown } | { ran: false; skipped: string };

/** Runs a tool as its agent: availability, entitlement and scope checks first. */
export async function runTool(tdb: TenantDb, deps: AgentDeps, name: string, input: Record<string, unknown> = {}, runId?: string): Promise<ToolResult> {
  const def = TOOLS.get(name);
  if (!def) throw new PermanentError(`unknown tool ${name}`);
  const ctx = await AgentContext.create(tdb, def.agent, deps, runId);
  if (!ctx.agent.tools.includes(name)) throw new PermanentError(`${name} is not a tool of ${ctx.agent.id}`);
  const active = await ctx.active();
  if (!active.ok) return { ran: false, skipped: active.reason };
  ctx.requireScopes(def.scopes);
  return { ran: true, output: await def.run(ctx, input) };
}
