import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/catalog/agents.ts";
import { BUSINESS_ACTIONS } from "../src/catalog/actions.ts";
import { INDUSTRY_PACKS } from "../src/catalog/industries.ts";
import { PLANS, billableAgents } from "../src/catalog/plans.ts";
import { GST_HST_BP, taxRateFor } from "../src/catalog/tax.ts";
import { TOOLS } from "../src/tools/index.ts";
import { WORKFLOWS } from "../src/workflows.ts";

describe("Business AI catalog", () => {
  it("defines the 21 agents of the brief, numbered 1–21", () => {
    expect(AGENTS.map((a) => a.number)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(21);
  });

  it("every operational agent has real tools that exist, and planned agents have none", () => {
    for (const a of AGENTS) {
      if (a.status === "operational") expect(a.tools.length, a.id).toBeGreaterThan(0);
      else expect(a.tools, a.id).toEqual([]);
      for (const name of a.tools) {
        const t = TOOLS.get(name);
        expect(t, `${a.id}: ${name}`).toBeDefined();
        expect(t!.agent).toBe(a.id);
        for (const s of t!.scopes) expect(a.scopes, `${name} needs ${s}`).toContain(s);
      }
    }
    for (const [name, t] of TOOLS) expect(AGENTS.find((a) => a.id === t.agent)?.tools, name).toContain(name);
  });

  it("marketing agents never hold personal-data scopes", () => {
    for (const a of AGENTS.filter((x) => x.marketing)) expect(a.scopes, a.id).not.toContain("customers.pii");
  });

  it("every agent action is in the action catalog with a level", () => {
    for (const a of AGENTS) for (const act of a.actions) expect(Object.hasOwn(BUSINESS_ACTIONS, act), `${a.id}: ${act}`).toBe(true);
    for (const [t, p] of Object.entries(BUSINESS_ACTIONS)) {
      expect([1, 2, 3], t).toContain(p.level);
      if (p.level === 2) expect("rule" in p && p.rule, t).toBeTruthy();
    }
  });

  it("plans never bill planned agents, and each plan includes the one below", () => {
    for (const p of PLANS) {
      expect(p.priceCents).toBeNull();
      for (const id of billableAgents(p.id)) expect(AGENTS.find((a) => a.id === id)?.status).toBe("operational");
    }
    for (let i = 1; i < PLANS.length; i++) for (const id of PLANS[i - 1]!.agents) expect(PLANS[i]!.agents).toContain(id);
    expect(billableAgents("premium")).not.toContain("inventory");
  });

  it("has the 25 industry packs with complete, distinct configurations", () => {
    expect(INDUSTRY_PACKS).toHaveLength(25);
    expect(new Set(INDUSTRY_PACKS.map((p) => p.id)).size).toBe(25);
    for (const p of INDUSTRY_PACKS) {
      expect(p.enquiries.length, p.id).toBeGreaterThan(0);
      expect(p.bookingFields.length, p.id).toBeGreaterThan(0);
      expect(p.kpis.length, p.id).toBeGreaterThan(0);
      for (const a of p.agents) expect(AGENTS.some((x) => x.id === a), `${p.id}: ${a}`).toBe(true);
    }
    const snow = INDUSTRY_PACKS.find((p) => p.id === "snow-removal")!;
    expect(snow.workflows.weatherAware).toBe(true);
    expect(INDUSTRY_PACKS.find((p) => p.id === "plumbing")!.workflows.emergency).toBe(true);
    expect(INDUSTRY_PACKS.find((p) => p.id === "moving")!.workflows.vehicleCapacity).toBe(true);
    expect(INDUSTRY_PACKS.find((p) => p.id === "residential-cleaning")!.workflows.recurring).toBe(true);
  });

  it("workflows only use registered tools", () => {
    for (const w of WORKFLOWS) for (const s of w.steps) expect(TOOLS.has(s.tool), `${w.id}: ${s.tool}`).toBe(true);
  });

  it("GST/HST rates match the CRA table (in effect from 1 April 2025)", () => {
    expect(GST_HST_BP.NB!.bp).toBe(1500);
    expect(GST_HST_BP.NS!.bp).toBe(1400);
    expect(GST_HST_BP.ON!.bp).toBe(1300);
    expect(Object.keys(GST_HST_BP)).toHaveLength(13);
    expect(taxRateFor("NB", false).bp).toBe(0);
    expect(taxRateFor(undefined, true).note).toMatch(/province/);
    expect(taxRateFor("QC", true).note).toMatch(/Provincial sales tax/);
  });
});
