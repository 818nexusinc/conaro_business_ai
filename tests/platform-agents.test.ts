import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { createAdmin } from "../src/admin/auth.ts";
import { clearContentCache } from "../src/admin/content.ts";
import { clearPlanCache } from "../src/admin/plans.ts";
import { runPlatformAgents, runPlatformAgentsIfDue, snapshot, type PlatformContext } from "../src/platform/agents.ts";
import { SimulatedReasoning, type ReasoningPort } from "../src/shared/reasoning.ts";

const PW = "correct horse battery staple";
const CTX: PlatformContext = { setupKeySet: true, frReviewed: false, billingProblem: "Stripe is not configured (STRIPE_SECRET_KEY).", billingMode: null, webhookConfigured: false, liveApproved: false };
/** A model stand-in that proposes copy: one good suggestion, one with an invented figure, one for a key it may not touch. */
const copywriter: ReasoningPort = { async analyse(req) {
  expect(req.prompt).toContain("<untrusted_data");
  return { simulated: false, usage: { provider: "test", model: "test", outcome: "succeeded", inputTokens: 1, outputTokens: 1, latencyMs: 1 }, analysis: { summary: "ok", findings: [], recommendations: [], dataGaps: [], injectionAttemptsObserved: [], proposedActions: [
    { actionType: "site.copy", title: "t", rationale: "Shorter and clearer.", payloadJson: JSON.stringify({ key: "hero.lead", lang: "en", value: "Your AI team answers, quotes, books and invoices while you work." }) },
    { actionType: "site.copy", title: "t", rationale: "Bold claim.", payloadJson: JSON.stringify({ key: "hero.title2", lang: "en", value: "Grow 40% faster." }) },
    { actionType: "site.copy", title: "t", rationale: "x", payloadJson: JSON.stringify({ key: "footer.place", lang: "en", value: "Anywhere" }) },
  ] } };
} };

let db: Db; let server: Server; let base: string;
beforeEach(async () => {
  db = await freshDb(); clearContentCache(); clearPlanCache();
  server = createPortalServer({ db, app: bai(new Date("2026-11-18T14:00:00Z")), linkSecret: SECRET, setupKey: "setup-key-0123456789abcdef0123456789", landing: { signupOpen: true } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

async function signIn(email: string) {
  const r = await fetch(`${base}/admin/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ email, password: PW }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const html = await (await fetch(`${base}/admin/agents`, { headers: { cookie } })).text();
  return { cookie, csrf: html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "", html };
}
const post = (s: { cookie: string; csrf: string }, path: string, body: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual",
  headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ _csrf: s.csrf, ...body }) });

describe("the platform's own agents", () => {
  it("analyse aggregate data only and propose without duplicates", async () => {
    const a = await seedBusiness(db, "alpha");
    await db.query("update bai_tenants set created_at = now() - interval '5 days' where id = $1", [a.tenantId]);
    await db.query("update bai_profiles set completeness = 20 where tenant_id = $1", [a.tenantId]);
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    const snap = JSON.stringify(await snapshot(db));
    expect(snap).not.toContain("Sparkle alpha");
    expect(snap).not.toMatch(/@/);

    const r = await runPlatformAgents(db, copywriter, CTX, "test");
    expect(r.every((x) => x.outcome === "succeeded")).toBe(true);
    const titles = (await db.query<{ title: string; kind: string }>("select title, kind from bai_platform_proposals where status = 'pending'")).map((p) => `${p.kind}:${p.title}`);
    expect(titles).toEqual(expect.arrayContaining(["task:Announce plan prices", "task:Remove BAI_SETUP_KEY from the host", "task:Add a second platform owner",
      "task:Have the French website reviewed", "outreach.draft:Check in with 1 business(es) stuck in set-up", "site.copy:New wording for hero.lead"]));
    expect(titles.join()).not.toContain("hero.title2"); // invented figure filtered out
    expect(titles.join()).not.toContain("footer.place"); // not a key the agent may change
    const count = titles.length;
    await runPlatformAgents(db, copywriter, CTX, "test");
    expect((await db.query("select 1 from bai_platform_proposals where status = 'pending'")).length).toBe(count);
    const finance = (await db.query<{ summary: { findings: { label: string; kind: string }[] } }>("select summary from bai_platform_agent_runs where agent_id = 'finance' order by id desc limit 1"))[0]!;
    expect(finance.summary.findings.find((f) => f.label.startsWith("Monthly recurring revenue"))!.kind).toBe("ESTIMATE");
    // Without an AI key the marketing agent says so instead of pretending.
    await runPlatformAgents(db, new SimulatedReasoning(), CTX, "test");
    expect(((await db.query<{ simulated: boolean }>("select simulated from bai_platform_agent_runs where agent_id = 'growth-marketing' order by id desc limit 1"))[0]!).simulated).toBe(true);
  });

  it("lets only an owner decide; approving creates drafts and sends nothing", async () => {
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    await createAdmin(db, { email: "ed@conaro.example", name: "Editor", password: PW, role: "editor" }, "test");
    await createAdmin(db, { email: "view@conaro.example", name: "Viewer", password: PW, role: "viewer" }, "test");
    const viewer = await signIn("view@conaro.example");
    expect((await post(viewer, "/admin/do/agents-run")).status).toBe(403);
    const ed = await signIn("ed@conaro.example");
    expect(decodeURIComponent((await post(ed, "/admin/do/agents-run")).headers.get("location") ?? "")).toMatch(/Agents ran: \d+ new proposal/);
    await runPlatformAgents(db, copywriter, CTX, "test");
    const copy = (await db.query<{ id: string }>("select id from bai_platform_proposals where kind = 'site.copy' and status = 'pending'"))[0]!;
    expect((await post(ed, "/admin/do/proposal", { id: copy.id, decision: "approve" })).status).toBe(403);

    const owner = await signIn("owner@conaro.example");
    expect(owner.html).toContain("Waiting for your decision");
    expect(owner.html).toContain("Run all agents now");
    expect(decodeURIComponent((await post(owner, "/admin/do/proposal", { id: copy.id, decision: "approve" })).headers.get("location") ?? "")).toContain("Saved as a website draft (hero.lead)");
    expect(await (await fetch(`${base}/?lang=en`)).text()).not.toContain("Your AI team answers, quotes, books and invoices while you work.");
    expect((await db.query("select 1 from bai_site_content where key = 'hero.lead' and draft_changed")).length).toBe(1);
    expect(decodeURIComponent((await post(owner, "/admin/do/proposal", { id: copy.id, decision: "approve" })).headers.get("location") ?? "")).toContain("already decided");
    const outreach = (await db.query<{ id: string }>("select id from bai_platform_proposals where kind = 'task' and status = 'pending' limit 1"))[0]!;
    expect(decodeURIComponent((await post(owner, "/admin/do/proposal", { id: outreach.id, decision: "reject" })).headers.get("location") ?? "")).toContain("rejected");
    expect((await db.query<{ action: string }>("select action from bai_admin_audit where action like 'proposal.%'")).length).toBe(2);
  });

  it("withdraws proposals that no longer apply, and lets an owner pause a business", async () => {
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    await runPlatformAgents(db, new SimulatedReasoning(), CTX, "test");
    const open = async () => (await db.query<{ title: string }>("select title from bai_platform_proposals where status = 'pending'")).map((p) => p.title);
    expect(await open()).toContain("Add a second platform owner");
    await createAdmin(db, { email: "owner2@conaro.example", name: "Owner 2", password: PW, role: "owner" }, "test");
    await runPlatformAgents(db, new SimulatedReasoning(), CTX, "test");
    expect(await open()).not.toContain("Add a second platform owner");
    expect((await db.query("select 1 from bai_platform_proposals where status = 'expired' and title = 'Add a second platform owner'")).length).toBe(1);

    const a = await seedBusiness(db, "alpha");
    const owner = await signIn("owner@conaro.example");
    const page = await (await fetch(`${base}/admin/businesses`, { headers: { cookie: owner.cookie } })).text();
    expect(page).toContain("Sparkle alpha");
    expect(page).not.toMatch(/owner@alpha/);
    await post(owner, "/admin/do/business-pause", { id: a.tenantId, pause: "yes" });
    expect((await db.query<{ paused: boolean }>("select paused from bai_tenants where id = $1", [a.tenantId]))[0]!.paused).toBe(true);
    await post(owner, "/admin/do/business-pause", { id: a.tenantId, pause: "no" });
    expect((await db.query<{ paused: boolean }>("select paused from bai_tenants where id = $1", [a.tenantId]))[0]!.paused).toBe(false);
  });

  it("runs once a day from the scheduled cycle", async () => {
    expect(await runPlatformAgentsIfDue(db, new SimulatedReasoning(), CTX)).toBe(true);
    expect(await runPlatformAgentsIfDue(db, new SimulatedReasoning(), CTX)).toBe(false);
  });
});
