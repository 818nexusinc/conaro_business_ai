import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai } from "./fixtures.ts";
import { seedDemo, removeDemo } from "../src/demo.ts";
import { portalLogin } from "../src/portal/auth.ts";
import { withTenant } from "../src/tenancy.ts";
import { buildSummary } from "../src/interop/bos.ts";
import type { AddressInfo } from "node:net";
import { createPortalServer } from "../src/portal/server.ts";
import { SECRET } from "./fixtures.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
afterEach(async () => { await db.close(); });

describe("demo accounts", () => {
  it("creates three flagged demo businesses with working logins for every role and real agent activity", async () => {
    const deps = bai(new Date()).deps;
    const r = await seedDemo(db, deps);
    expect(r.created).toEqual(["demo-sparkle", "demo-northshore", "demo-riverview-plumbing"]);
    expect(r.credentials).toHaveLength(8);
    expect(new Set(r.credentials.map((c) => c.role))).toEqual(new Set(["owner", "manager", "staff", "accountant", "viewer"]));
    for (const c of r.credentials) {
      expect(c.email).toMatch(/@demo-[a-z-]+\.example\.com$/);
      expect(c.password.length).toBeGreaterThanOrEqual(16);
      expect((await portalLogin(db, c.email, c.password, "127.0.0.1")).ok, c.email).toBe(true);
    }
    const tenants = await db.query<{ id: string; slug: string; is_demo: boolean; status: string }>("select id, slug, is_demo, status from bai_tenants order by created_at");
    expect(tenants.every((t) => t.is_demo && t.status === "active")).toBe(true);
    await withTenant(db, tenants[0]!.id, async (t) => {
      const count = async (sql: string) => Number((await t.query<{ n: number }>(sql))[0]!.n);
      expect(await count("select count(*)::int n from bai_leads")).toBe(5);
      expect(await count("select count(*)::int n from bai_invoices where status = 'paid'")).toBe(7);
      expect(await count("select count(*)::int n from bai_transactions")).toBe(12);
      expect(await count("select count(*)::int n from bai_bookings where status = 'confirmed'")).toBe(1);
      expect(await count("select count(*)::int n from bai_approvals where status = 'pending'")).toBeGreaterThan(0);
      expect(await count("select count(*)::int n from bai_messages where direction = 'outbound' and not simulated")).toBe(0);
      expect(await t.query("select workflow, error from bai_workflow_runs where status = 'failed'")).toEqual([]);
    });
    // The operating system's summary leaves demo businesses out.
    expect((await buildSummary(db)).workspaces.total).toBe(0);
  });

  it("running it again gives new passwords and never duplicates data; removal locks the logins out", async () => {
    const deps = bai(new Date()).deps;
    const first = await seedDemo(db, deps);
    const leadsBefore = (await db.query<{ n: number }>("select count(*)::int n from bai_leads"))[0]!.n;
    const again = await seedDemo(db, deps);
    expect(again.created).toEqual([]);
    expect(again.reset).toHaveLength(3);
    expect((await db.query<{ n: number }>("select count(*)::int n from bai_leads"))[0]!.n).toBe(leadsBefore);
    const old = first.credentials[0]!; const fresh = again.credentials.find((c) => c.email === old.email)!;
    expect(fresh.password).not.toBe(old.password);
    expect((await portalLogin(db, old.email, old.password, "127.0.0.2")).ok).toBe(false);
    expect((await portalLogin(db, fresh.email, fresh.password, "127.0.0.3")).ok).toBe(true);
    expect(await removeDemo(db)).toBe(3);
    expect((await portalLogin(db, fresh.email, fresh.password, "127.0.0.4")).ok).toBe(false);
  });
});

describe("set-up page", () => {
  const KEY = "setup-key-0123456789abcdef-0123456789";
  async function serve(setupKey?: string) {
    const server = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET, ...(setupKey ? { setupKey } : {}) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (form: Record<string, string>) => fetch(`${base}/setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(form) });
    return { server, base, post };
  }

  it("is off without BAI_SETUP_KEY", async () => {
    const { server, base, post } = await serve();
    expect(await (await fetch(`${base}/setup`)).text()).toContain("Set-up is off");
    expect((await post({ key: KEY, action: "demo" })).status).toBe(403);
    await new Promise((r) => server.close(r));
  });

  it("refuses wrong keys (then pauses), creates demo accounts and a first business with the right key", async () => {
    const { server, base, post } = await serve(KEY);
    expect((await post({ key: "wrong", action: "demo" })).status).toBe(401);
    const page = await post({ key: KEY, action: "demo" });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("owner@demo-sparkle.example.com");
    const pw = body.match(/owner@demo-sparkle\.example\.com<\/code><br>Password: <code class="password">([^<]+)</)?.[1] ?? "";
    expect(pw.length).toBeGreaterThanOrEqual(16);
    const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@demo-sparkle.example.com", password: pw }) });
    expect(login.status).toBe(303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toContain("DEMO WORKSPACE");
    const biz = await post({ key: KEY, action: "business", name: "Real Test Co", slug: "real-test", industry: "handyman", plan: "starter", owner: "Owner", email: "owner@real-test.example.com", password: "correct horse battery staple" });
    expect(await biz.text()).toContain("Created Real Test Co");
    expect((await db.query<{ is_demo: boolean }>("select is_demo from bai_tenants where slug = 'real-test'"))[0]!.is_demo).toBe(false);
    for (let i = 0; i < 5; i++) await post({ key: "wrong-again", action: "demo" });
    expect((await post({ key: KEY, action: "demo" })).status).toBe(429);
    await new Promise((r) => server.close(r));
  });
});
