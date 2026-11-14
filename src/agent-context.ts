import { AccessDeniedError, PermanentError } from "./shared/errors.ts";
import { json } from "./shared/db.ts";
import type { ReasoningPort } from "./shared/reasoning.ts";
import type { TenantDb } from "./tenancy.ts";
import { agentDef, type AgentDefinition, type Scope } from "./catalog/agents.ts";
import { industryPack, type IndustryPack } from "./catalog/industries.ts";
import { isEntitled } from "./catalog/plans.ts";
import type { BusinessActionOutcome, BusinessActionRequest, TenantGateway } from "./gateway.ts";
import { unsubscribeToken } from "./consent.ts";
import { getPolicy, type Policy } from "./settings.ts";
import { getProfileData, type ProfileData } from "./profile.ts";

export interface AgentDeps {
  gateway: TenantGateway;
  reasoning: ReasoningPort;
  now?: () => Date;
  /** Public base URL of the Business AI portal (for unsubscribe links). */
  publicBaseUrl: string;
  /** Key that signs unsubscribe links (BAI_LINK_SECRET). */
  linkSecret: string;
}

/** What a tool sees: one tenant, one agent, its scopes, and the gateway. */
export class AgentContext {
  readonly now: Date;
  private constructor(
    readonly tdb: TenantDb,
    readonly agent: AgentDefinition,
    readonly deps: AgentDeps,
    readonly pack: IndustryPack,
    readonly policy: Policy,
    readonly profile: ProfileData,
    readonly tenant: { name: string; time_zone: string },
    readonly runId: string | undefined,
  ) {
    this.now = deps.now?.() ?? new Date();
  }

  static async create(tdb: TenantDb, agentId: string, deps: AgentDeps, runId?: string): Promise<AgentContext> {
    const agent = agentDef(agentId);
    if (agent.status !== "operational") throw new PermanentError(`${agent.name} is not available yet`);
    const row = (await tdb.query<{ name: string; industry: string; time_zone: string }>("select name, industry, time_zone from bai_tenants"))[0];
    if (!row) throw new AccessDeniedError("tenant not visible");
    return new AgentContext(tdb, agent, deps, industryPack(row.industry), await getPolicy(tdb), await getProfileData(tdb), row, runId);
  }

  /** Is this agent switched on and in the plan? */
  async active(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const a = (await this.tdb.query<{ enabled: boolean }>("select enabled from bai_agents where agent_id = $1", [this.agent.id]))[0];
    if (!a?.enabled) return { ok: false, reason: `${this.agent.name} is switched off` };
    const sub = (await this.tdb.query<{ plan: string; addons: string[] }>("select plan, addons from bai_subscriptions"))[0];
    if (!sub || !isEntitled(sub.plan, sub.addons, this.agent.id)) return { ok: false, reason: `${this.agent.name} is not in the plan` };
    return { ok: true };
  }

  requireScopes(scopes: readonly Scope[]): void {
    const missing = scopes.filter((s) => !this.agent.scopes.includes(s));
    if (missing.length) throw new AccessDeniedError(`${this.agent.id} lacks data scope ${missing.join(", ")}`);
  }

  act(req: Omit<BusinessActionRequest, "agentId" | "runId">): Promise<BusinessActionOutcome> {
    return this.deps.gateway.submit(this.tdb, { ...req, agentId: this.agent.id, ...(this.runId ? { runId: this.runId } : {}) });
  }

  /** Records a recommendation, opportunity or issue (deduplicated) through the gateway. */
  async recommend(r: { kind: "recommendation" | "opportunity" | "issue"; title: string; rationale: string; assumptions?: string[]; dataBasis?: Record<string, unknown>; dedupeKey: string }): Promise<boolean> {
    const out = await this.act({ actionType: "recommendation.record", title: r.title, payload: { kind: r.kind }, idempotencyKey: `rec:${r.dedupeKey}` });
    if (out.status !== "done") return false;
    await this.tdb.query(
      `insert into bai_recommendations (agent_id, kind, title, rationale, assumptions, data_basis, dedupe_key)
       values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7) on conflict (tenant_id, dedupe_key) do nothing`,
      [this.agent.id, r.kind, r.title, r.rationale, json(r.assumptions ?? []), json(r.dataBasis ?? {}), r.dedupeKey]);
    return true;
  }

  unsubscribeUrl(email: string): string {
    return `${this.deps.publicBaseUrl.replace(/\/$/, "")}/u/${unsubscribeToken(this.tdb.tenantId, email, this.deps.linkSecret)}`;
  }

  async remember(key: string, value: unknown): Promise<void> {
    await this.tdb.query(
      `insert into bai_agent_memory (agent_id, key, value) values ($1, $2, $3::text::jsonb)
       on conflict (tenant_id, agent_id, key) do update set value = excluded.value, updated_at = now()`, [this.agent.id, key, json(value)]);
  }

  async recall<T>(key: string): Promise<T | null> {
    const r = await this.tdb.query<{ value: T }>("select value from bai_agent_memory where agent_id = $1 and key = $2", [this.agent.id, key]);
    return r[0]?.value ?? null;
  }

  async adminTask(title: string, kind: "task" | "deadline" | "reminder", dedupeKey: string, dueOn?: string): Promise<void> {
    await this.tdb.query(
      `insert into bai_admin_tasks (title, kind, due_on, source_agent, dedupe_key) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, dedupe_key) do nothing`, [title, kind, dueOn ?? null, this.agent.id, dedupeKey]);
  }

  /** The business's identification for outgoing messages (CASL requires it on commercial messages). */
  identification(): { senderName: string; mailingAddress?: string; contact: { email?: string; phone?: string; url?: string } } {
    const id = this.profile.identity;
    return {
      senderName: this.tenant.name,
      ...(id.mailingAddress ? { mailingAddress: id.mailingAddress } : {}),
      contact: { ...(id.email ? { email: id.email } : {}), ...(id.phone ? { phone: id.phone } : {}), ...(id.website ? { url: id.website } : {}) },
    };
  }
}
