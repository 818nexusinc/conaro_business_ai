import { AGENTS, agentDef } from "./agents.ts";

/**
 * Subscription plans and entitlements (brief §13).
 *
 * Prices are deliberately not set: the brief forbids hard-coding them before
 * operating costs and demand are validated. `priceCents` stays null until the
 * owner sets it; the portal shows "price not set".
 *
 * Usage limits are provisional operating guardrails (protect AI spend), not
 * commercial terms, and can be changed per plan by the owner of CONARO.
 */
export interface Plan {
  id: "starter" | "growth" | "professional" | "premium";
  name: string;
  priceCents: number | null;
  agents: string[];
  limits: { aiCallsPerMonth: number; externalActionsPerMonth: number; employees: number; locations: number };
  features: string[];
}

const STARTER = ["business-manager", "booking", "customer-service", "growth-analyst"];
const GROWTH = [...STARTER, "marketing-director", "social-media-manager", "local-seo", "sales", "crm", "quotation", "reputation"];
const PROFESSIONAL = [...GROWTH, "accounting", "tax", "invoicing", "workforce", "operations", "admin-assistant", "financial-analyst", "inventory"];
const PREMIUM = AGENTS.map((a) => a.id);

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", priceCents: null, agents: STARTER,
    limits: { aiCallsPerMonth: 300, externalActionsPerMonth: 500, employees: 1, locations: 1 },
    features: ["AI Business Manager", "Basic booking assistance", "Basic customer service", "Business insights"] },
  { id: "growth", name: "Growth", priceCents: null, agents: GROWTH,
    limits: { aiCallsPerMonth: 1500, externalActionsPerMonth: 3000, employees: 5, locations: 1 },
    features: ["Social media", "SEO and lead generation", "CRM and retention", "Quotation assistance", "Business reporting"] },
  { id: "professional", name: "Professional", priceCents: null, agents: PROFESSIONAL,
    limits: { aiCallsPerMonth: 5000, externalActionsPerMonth: 10000, employees: 25, locations: 1 },
    features: ["Bookkeeping assistance", "Tax preparation assistance", "Employee and operations management", "Financial analytics"] },
  { id: "premium", name: "Premium", priceCents: null, agents: PREMIUM,
    limits: { aiCallsPerMonth: 20000, externalActionsPerMonth: 50000, employees: 200, locations: 10 },
    features: ["Full AI workforce", "Multi-employee workflows", "Multi-location (planned)", "Configurable autonomous execution"] },
];

export const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]));

export function planFor(id: string): Plan {
  const p = PLAN_BY_ID.get(id as Plan["id"]);
  if (!p) throw new Error(`unknown plan ${id}`);
  return p;
}

/** Agents a tenant is entitled to AND that actually work today (what may be billed). */
export function billableAgents(planId: string, addons: string[] = []): string[] {
  const ids = new Set([...planFor(planId).agents, ...addons]);
  return [...ids].filter((id) => agentDef(id).status === "operational");
}

export function isEntitled(planId: string, addons: string[], agentId: string): boolean {
  return planFor(planId).agents.includes(agentId) || addons.includes(agentId);
}
