import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { handleProviderFeed, businessAiSignInUrl, decodeCursor, type Cursor, type FeedBooking, type FeedRequest, type ProviderFeedPort } from "../integration/marketplace-kit/provider-feed.ts";
import { MarketplaceFeedClient, syncMarketplace } from "../src/interop/marketplace.ts";
import { signLinkRequest } from "../src/interop/protocol.ts";
import { withTenant } from "../src/tenancy.ts";
import { createPortalServer } from "../src/portal/server.ts";

const MK = "marketplace-link-key-0123456789abcdef-test";

/** An in-memory marketplace implementing the kit's port, as the real one would with SQL. */
class MemoryMarketplace implements ProviderFeedPort {
  providers = new Map<string, "pending" | "active" | "suspended">([["prov-1", "active"], ["prov-2", "active"]]);
  requests: (FeedRequest & { changedAt: string; provider: string })[] = [];
  bookings: (FeedBooking & { changedAt: string; provider: string })[] = [];
  nonces = new Set<string>();
  async providerStatus(ref: string) { return this.providers.get(ref) ?? null; }
  private after<T extends { changedAt: string; id: string; provider: string }>(list: T[], ref: string, c: { at: string; id: string } | null, limit: number) {
    return list.filter((x) => x.provider === ref && (!c || x.changedAt > c.at || (x.changedAt === c.at && x.id > c.id)))
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt) || a.id.localeCompare(b.id)).slice(0, limit)
      .map(({ provider: _p, ...rest }) => rest);
  }
  async requestsChangedAfter(ref: string, c: Cursor | null, limit: number) { return this.after(this.requests, ref, c?.requests ?? null, limit); }
  async bookingsChangedAfter(ref: string, c: Cursor | null, limit: number) { return this.after(this.bookings, ref, c?.bookings ?? null, limit); }
  async useNonce(n: string) { if (this.nonces.has(n)) return false; this.nonces.add(n); return true; }
}

let db: Db; let server: Server; let base: string; let mk: MemoryMarketplace;
beforeEach(async () => {
  db = await freshDb();
  mk = new MemoryMarketplace();
  server = createServer(async (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await handleProviderFeed({ method: req.method ?? "GET", pathAndQuery: req.url ?? "/", headers }, MK, mk);
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

describe("marketplace kit (the marketplace's side of the link)", () => {
  it("serves one provider's requests and bookings to Business AI, page by page, never another provider's", async () => {
    const a = await seedBusiness(db, "alpha");
    await withTenant(db, a.tenantId, (t) => t.query("update bai_tenants set marketplace_provider_ref = 'prov-1'"));
    const customer = { name: "Pat Example", email: "pat@example.test", phone: null, language: "en-CA" as const };
    mk.requests.push(
      { provider: "prov-1", id: "r1", changedAt: "2026-11-18T10:00:00Z", createdAt: "2026-11-18T10:00:00Z", category: "house cleaning", community: "Moncton", description: "Standard clean please", desiredDate: null, customer, expressMarketingConsent: false },
      { provider: "prov-2", id: "r2", changedAt: "2026-11-18T10:05:00Z", createdAt: "2026-11-18T10:05:00Z", category: "house cleaning", community: "Dieppe", description: "Someone else's request", desiredDate: null, customer: null, expressMarketingConsent: false },
    );
    const client = new MarketplaceFeedClient(base, MK);
    expect(await syncMarketplace(db, client, a.tenantId)).toMatchObject({ synced: true });
    await withTenant(db, a.tenantId, async (t) => {
      const leads = await t.query<{ description: string }>("select description from bai_leads");
      expect(leads.map((l) => l.description)).toEqual(["Standard clean please"]);
      // The kit never sends a customer on an unbooked request, even if the port returned one.
      expect((await t.query<{ name: string; email: string | null }>("select name, email from bai_customers"))[0]).toEqual({ name: "Marketplace customer r1", email: null });
      const cursor = decodeCursor((await t.query<{ cursor: string }>("select cursor from bai_sync_state"))[0]!.cursor);
      expect(cursor).toEqual({ requests: { at: "2026-11-18T10:00:00Z", id: "r1" }, bookings: null });
    });
    mk.bookings.push({ provider: "prov-1", id: "b1", requestId: "r1", status: "scheduled", startsAt: "2026-11-23T13:00:00Z", endsAt: "2026-11-23T16:00:00Z", customer, changedAt: "2026-11-18T11:00:00Z" });
    expect(await syncMarketplace(db, client, a.tenantId)).toMatchObject({ synced: true });
    await withTenant(db, a.tenantId, async (t) => {
      expect(await t.query("select 1 from bai_leads")).toHaveLength(1);
      expect((await t.query<{ status: string; source: string }>("select status, source from bai_bookings"))[0]).toEqual({ status: "confirmed", source: "conaro-marketplace" });
      expect((await t.query<{ name: string }>("select name from bai_customers"))[0]!.name).toBe("Pat Example");
    });
  });

  it("refuses unsigned, replayed and wrongly keyed calls, and says when no key is saved or the provider is unknown", async () => {
    const path = "/api/bai/v1/provider-feed?provider=prov-1";
    const call = (headers: Record<string, string>) => fetch(`${base}${path}`, { headers });
    expect((await call({})).status).toBe(401);
    const signed = signLinkRequest(MK, "GET", path);
    expect((await call(signed)).status).toBe(200);
    expect((await call(signed)).status).toBe(401);
    expect((await call(signLinkRequest("another-key-0123456789abcdef-0000000", "GET", path))).status).toBe(401);
    const unknown = "/api/bai/v1/provider-feed?provider=nobody";
    expect((await fetch(`${base}${unknown}`, { headers: signLinkRequest(MK, "GET", unknown) })).status).toBe(404);
    expect(await handleProviderFeed({ method: "GET", pathAndQuery: path, headers: signLinkRequest(MK, "GET", path) }, null, mk)).toMatchObject({ status: 503 });
  });

  it("the Open Business AI button signs an existing member in", async () => {
    const a = await seedBusiness(db, "alpha");
    await withTenant(db, a.tenantId, (t) => t.query("update bai_tenants set marketplace_provider_ref = 'prov-1'"));
    const portal = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET, marketplaceLinkSecret: MK });
    await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
    const portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
    const r = await fetch(businessAiSignInUrl(portalUrl, MK, "prov-1", "owner@alpha.example.test"), { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toMatch(/^bai_session=/);
    await new Promise((res) => portal.close(res));
  });
});
