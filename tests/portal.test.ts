import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { withTenant } from "../src/tenancy.ts";
import { addMember } from "../src/tenants.ts";
import { receiveEnquiry } from "../src/tools/revenue.ts";
import { processTenant } from "../src/workflows.ts";
import { checkCustomerConsent, unsubscribeToken } from "../src/consent.ts";

let db: Db; let server: Server; let base: string;
const NOW = new Date("2026-11-18T14:00:00Z");

beforeEach(async () => {
  db = await freshDb();
  server = createPortalServer({ db, app: bai(NOW), linkSecret: SECRET });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

async function signIn(email: string, password = "correct horse battery staple") {
  const r = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }) });
  expect(r.status).toBe(303);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  return { cookie, csrf };
}
const post = (s: { cookie: string; csrf: string }, path: string, form: Record<string, string>, csrf = s.csrf) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ _csrf: csrf, ...form }) });

describe("owner control centre", () => {
  it("renders every section for the owner, with no cross-tenant data", async () => {
    const a = await seedBusiness(db, "alpha");
    await seedBusiness(db, "bravo");
    await withTenant(db, a.tenantId, (t) => receiveEnquiry(t, { name: "Pat Alpha", email: "pat@example.test", description: "Standard clean in Moncton please", area: "Moncton", channel: "website" }, "test"));
    await processTenant(db, a.tenantId, bai(NOW).deps);
    const owner = await signIn("owner@alpha.example.test");
    for (const p of ["/", "/chat", "/approvals", "/growth", "/finance", "/enquiries", "/bookings", "/agents", "/activity", "/recommendations", "/reports", "/documents", "/settings", "/integrations", "/plan", "/audit"]) {
      const r = await fetch(`${base}${p}`, { headers: { cookie: owner.cookie } });
      expect(r.status, p).toBe(200);
      const body = await r.text();
      expect(body, p).toContain("SIMULATION");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    expect(await (await fetch(`${base}/enquiries`, { headers: { cookie: owner.cookie } })).text()).toContain("Pat Alpha");
    const bravo = await signIn("owner@bravo.example.test");
    expect(await (await fetch(`${base}/enquiries`, { headers: { cookie: bravo.cookie } })).text()).not.toContain("Pat Alpha");
    // Bravo cannot decide Alpha's approval even with its id.
    const apId = await withTenant(db, a.tenantId, async (t) => (await t.query<{ id: string }>("select id from bai_approvals limit 1"))[0]!.id);
    const r = await post(bravo, "/do/approval", { id: apId, decision: "approve" });
    expect(decodeURIComponent(r.headers.get("location") ?? "")).toMatch(/err=approval not found/);
    // Alpha's owner can.
    const ok = await post(owner, "/do/approval", { id: apId, decision: "approve" });
    expect(decodeURIComponent(ok.headers.get("location") ?? "")).toMatch(/ok=Approved: simulated/);
  });

  it("refuses missing CSRF tokens, cross-origin posts and actions outside the role", async () => {
    const a = await seedBusiness(db, "alpha");
    await addMember(db, a.tenantId, { email: "viewer@alpha.example.test", name: "V", password: "correct horse battery staple", role: "viewer" }, "test");
    const owner = await signIn("owner@alpha.example.test");
    expect((await post(owner, "/do/pause", {}, "wrong")).status).toBe(403);
    const cross = await fetch(`${base}/do/pause`, { method: "POST", redirect: "manual", headers: { cookie: owner.cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: new URLSearchParams({ _csrf: owner.csrf }) });
    expect(cross.status).toBe(403);
    const viewer = await signIn("viewer@alpha.example.test");
    expect((await post(viewer, "/do/policy", { auto_confirm_bookings: "true" })).status).toBe(403);
    expect((await fetch(`${base}/finance`, { headers: { cookie: viewer.cookie } })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { cookie: "bai_session=forged" }, redirect: "manual" })).status).toBe(303);
  });

  it("saves operating rules, profile and services from forms, and the pause button stops agents", async () => {
    const a = await seedBusiness(db, "alpha");
    const owner = await signIn("owner@alpha.example.test");
    const r = await post(owner, "/do/policy", { auto_confirm_bookings: "true", max_auto_quote_cents: "400.00", max_discount_pct: "10", payment_reminder_days: "7", reminder_hours_before: "24", travel_buffer_minutes: "30", quote_valid_days: "14", invoice_due_days: "14" });
    expect(decodeURIComponent(r.headers.get("location") ?? "")).toMatch(/ok=Operating rules saved/);
    const pol = await withTenant(db, a.tenantId, async (t) => (await t.query<{ policy: Record<string, unknown> }>("select policy from bai_settings"))[0]!.policy);
    expect(pol).toMatchObject({ auto_confirm_bookings: true, auto_send_quotes: false, max_auto_quote_cents: 40_000, max_discount_pct: 10 });
    const svc = await post(owner, "/do/service", { name: "Deep clean", category: "house cleaning", pricingUnit: "hourly", price: "55", duration: "240" });
    expect(decodeURIComponent(svc.headers.get("location") ?? "")).toMatch(/ok=Service saved/);
    await post(owner, "/do/pause", { reason: "holiday" });
    expect(await (await fetch(`${base}/`, { headers: { cookie: owner.cookie } })).text()).toContain("All agents are paused");
  });

  it("the signed unsubscribe link suppresses the address for that business only", async () => {
    const a = await seedBusiness(db, "alpha");
    const b = await seedBusiness(db, "bravo");
    for (const t of [a.tenantId, b.tenantId]) {
      await withTenant(db, t, (tdb) => receiveEnquiry(tdb, { name: "Sam", email: "sam@example.test", description: "Clean please", channel: "website" }, "test"));
    }
    const link = `${base}/u/${unsubscribeToken(a.tenantId, "sam@example.test", SECRET)}`;
    expect(await (await fetch(link)).text()).toContain("Unsubscribe");
    expect((await fetch(link, { method: "POST" })).status).toBe(200);
    expect(await withTenant(db, a.tenantId, (t) => checkCustomerConsent(t, "sam@example.test"))).toMatchObject({ allowed: false, reason: "suppressed" });
    expect(await withTenant(db, b.tenantId, (t) => checkCustomerConsent(t, "sam@example.test"))).toMatchObject({ allowed: true });
    expect((await fetch(`${base}/u/${unsubscribeToken(a.tenantId, "sam@example.test", "another-secret-0123456789abcdef")}`)).status).toBe(400);
  });
});
