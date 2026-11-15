import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { createAdmin } from "../src/admin/auth.ts";
import { clearPlanCache } from "../src/admin/plans.ts";
import { addMember } from "../src/tenants.ts";
import { formEncode, keyMode, signForTest, stripeClient, verifyWebhook, type Fetch } from "../src/billing/stripe.ts";
import { withTenant } from "../src/tenancy.ts";

const WHSEC = "whsec_testsecret0123456789";
const PW = "correct horse battery staple";

describe("Stripe primitives (as documented)", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", livemode: false, data: { object: { id: "in_1", customer: "cus_1" } } });
  it("verifies webhook signatures: HMAC-SHA256 of `t.body`, any v1, constant time, 5-minute tolerance", () => {
    const now = Date.now();
    expect(verifyWebhook(body, signForTest(body, WHSEC, Math.floor(now / 1000)), WHSEC, now).type).toBe("invoice.paid");
    const t = Math.floor(now / 1000);
    expect(verifyWebhook(body, `t=${t},v1=deadbeef,${signForTest(body, WHSEC, t).split(",")[1]}`, WHSEC, now).id).toBe("evt_1");
    expect(() => verifyWebhook(body, signForTest(body, "whsec_other", t), WHSEC, now)).toThrow(/does not match/);
    expect(() => verifyWebhook(body.replace("in_1", "in_2"), signForTest(body, WHSEC, t), WHSEC, now)).toThrow(/does not match/);
    expect(() => verifyWebhook(body, signForTest(body, WHSEC, t - 301), WHSEC, now)).toThrow(/tolerance/);
    expect(() => verifyWebhook(body, undefined, WHSEC, now)).toThrow(/missing/);
    expect(() => verifyWebhook(body, "t=1", WHSEC, now)).toThrow(/malformed/);
  });
  it("encodes nested parameters the way Stripe expects and refuses live keys without approval", () => {
    expect(formEncode({ line_items: [{ price: "price_123456", quantity: 1 }], metadata: { tenant_id: "x" } }).toString())
      .toBe("line_items%5B0%5D%5Bprice%5D=price_123456&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Btenant_id%5D=x");
    expect(keyMode("sk_test_abc")).toBe("test"); expect(keyMode("rk_live_abc")).toBe("live"); expect(keyMode("pk_test_abc")).toBe(null);
    expect(() => stripeClient({ secretKey: "sk_live_abc" })).toThrow(/not been approved/);
    expect(stripeClient({ secretKey: "sk_live_abc", liveApprovedBy: "Owner" }).mode).toBe("live");
  });
});

describe("billing end to end (Stripe replaced by a recording fake)", () => {
  let db: Db; let server: Server; let base: string;
  const calls: { url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const fake: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: new URLSearchParams(init.body) });
    if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", livemode: false }) };
    if (url.endsWith("/v1/billing_portal/sessions")) return { ok: true, status: 200, json: async () => ({ url: "https://billing.stripe.com/p/session/test_1" }) };
    return { ok: false, status: 404, json: async () => ({ error: { message: "nope" } }) };
  };
  beforeEach(async () => {
    db = await freshDb(); clearPlanCache(); calls.length = 0;
    server = createPortalServer({ db, app: bai(new Date("2026-11-18T14:00:00Z")), linkSecret: SECRET, billing: { secretKey: "sk_test_fake", webhookSecret: WHSEC }, stripeFetch: fake, publicUrl: "https://bai.example.com" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

  async function signIn(email: string, path: string, page: string) {
    const r = await fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ email, password: PW }) });
    const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const html = await (await fetch(`${base}${page}`, { headers: { cookie } })).text();
    return { cookie, csrf: html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "", html };
  }
  const post = (s: { cookie: string; csrf: string }, path: string, body: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ _csrf: s.csrf, ...body }) });
  const webhook = (event: unknown, secret = WHSEC) => { const raw = JSON.stringify(event); return fetch(`${base}/api/billing/stripe/webhook`, { method: "POST", headers: { "stripe-signature": signForTest(raw, secret), "content-type": "application/json" }, body: raw }); };
  const sub = async (tenantId: string) => withTenant(db, tenantId, async (t) => (await t.query<{ status: string; billing_status: string }>("select status, billing_status from bai_subscriptions"))[0]!);

  it("links a plan to a Stripe price, lets the owner subscribe in test mode, and follows Stripe's events", async () => {
    const a = await seedBusiness(db, "alpha", { plan: "growth" });
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    const admin = await signIn("owner@conaro.example", "/admin/login", "/admin/billing");
    expect(admin.html).toContain("test mode: no real money");
    expect(admin.html).toContain("https://bai.example.com/api/billing/stripe/webhook");
    expect(admin.html).not.toContain("sk_test_fake");
    expect(decodeURIComponent((await post(admin, "/admin/do/stripe-price", { plan: "growth", price_id: "nope" })).headers.get("location") ?? "")).toContain("starts with price_");
    await post(admin, "/admin/do/stripe-price", { plan: "growth", price_id: "price_GrowthTest01" });
    clearPlanCache();

    const owner = await signIn("owner@alpha.example.test", "/login", "/plan");
    expect(owner.html).toContain("Stripe test mode");
    expect(owner.html).toContain("Subscribe with a card");
    const r = await post(owner, "/do/checkout", { plan: "growth" });
    expect(r.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call.headers.Authorization).toBe("Bearer sk_test_fake");
    expect(call.body.get("mode")).toBe("subscription");
    expect(call.body.get("line_items[0][price]")).toBe("price_GrowthTest01");
    expect(call.body.get("client_reference_id")).toBe(a.tenantId);
    expect(call.body.get("success_url")).toMatch(/^https:\/\/bai\.example\.com\/plan\?ok=/);

    // A manager cannot start billing.
    await withTenant(db, a.tenantId, async () => {});
    await addMember(db, a.tenantId, { email: "mgr@alpha.example.test", name: "Mgr", password: PW, role: "manager" }, "test");
    const mgr = await signIn("mgr@alpha.example.test", "/login", "/plan");
    expect((await post(mgr, "/do/checkout", { plan: "growth" })).status).toBe(403);

    expect((await webhook({ id: "evt_x", type: "invoice.paid", livemode: false, data: { object: {} } }, "whsec_wrong")).status).toBe(400);
    const done = { id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_1", client_reference_id: a.tenantId, customer: "cus_A", subscription: "sub_A", metadata: { tenant_id: a.tenantId, plan: "growth" } } } };
    expect(await (await webhook(done)).json()).toMatchObject({ outcome: "subscription started" });
    expect(await (await webhook(done)).json()).toMatchObject({ outcome: "duplicate" });
    expect(await sub(a.tenantId)).toMatchObject({ status: "active", billing_status: "active" });

    await webhook({ id: "evt_2", type: "invoice.payment_failed", livemode: false, data: { object: { id: "in_1", customer: "cus_A" } } });
    expect(await sub(a.tenantId)).toMatchObject({ status: "past_due", billing_status: "payment_failed" });
    await webhook({ id: "evt_3", type: "customer.subscription.deleted", livemode: false, data: { object: { id: "sub_A", customer: "cus_A", status: "canceled" } } });
    expect(await sub(a.tenantId)).toMatchObject({ status: "cancelled", billing_status: "canceled" });
    expect(await (await webhook({ id: "evt_4", type: "checkout.session.completed", livemode: true, data: { object: { client_reference_id: a.tenantId } } })).json()).toMatchObject({ outcome: "refused: live mode not approved" });
    expect(await (await webhook({ id: "evt_5", type: "checkout.session.completed", livemode: false, data: { object: { client_reference_id: "00000000-0000-0000-0000-000000000000" } } })).json()).toMatchObject({ outcome: "ignored: unknown business" });

    // With a Stripe customer the owner can open Stripe's billing portal.
    expect((await post(owner, "/do/billing-portal")).headers.get("location")).toBe("https://billing.stripe.com/p/session/test_1");
    const events = await withTenant(db, a.tenantId, (t) => t.query<{ event: string }>("select event from bai_subscription_events order by id"));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["checkout_completed", "payment_failed", "subscription_ended"]));
  });
});
