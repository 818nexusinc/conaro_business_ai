import { z } from "zod";
import type { Db } from "../shared/db.ts";
import { maybeOne, one } from "../shared/db.ts";
import { withTenant, type TenantDb } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";
import { emitEvent } from "../events.ts";
import { receiveEnquiry } from "../tools/revenue.ts";
import { signLinkRequest } from "./protocol.ts";
import { logExchange } from "./link-server.ts";

/**
 * Read-only feed of ONE provider's marketplace requests and bookings, served by the marketplace at
 *   GET /api/bai/v1/provider-feed?provider=<ref>&since=<cursor>
 * and signed with the link protocol (key BAI_MARKETPLACE_LINK_SECRET here). The contract is in
 * docs/INTEROP.md. Business AI never writes to the marketplace: it reads, and keeps its own records.
 *
 * Privacy: the marketplace hides a customer's identity until a booking exists; the feed follows the
 * same rule (`customer: null` on requests that are not booked).
 */
const Customer = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().nullable(),
  phone: z.string().max(40).nullable(),
  language: z.enum(["en-CA", "fr-CA"]).default("en-CA"),
}).nullable();

export const ProviderFeed = z.object({
  version: z.literal(1),
  provider: z.object({ ref: z.string().min(1).max(100), status: z.enum(["pending", "active", "suspended"]) }),
  cursor: z.string().max(200),
  requests: z.array(z.object({
    id: z.string().min(1).max(100),
    createdAt: z.string(),
    category: z.string().max(80),
    community: z.string().max(80).nullable(),
    description: z.string().min(1).max(5000),
    desiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    customer: Customer.default(null),
    expressMarketingConsent: z.boolean().default(false),
  })).max(500),
  bookings: z.array(z.object({
    id: z.string().min(1).max(100),
    requestId: z.string().min(1).max(100),
    status: z.enum(["scheduled", "completed", "cancelled"]),
    startsAt: z.string(),
    endsAt: z.string(),
    customer: Customer.default(null),
  })).max(500),
});
export type ProviderFeed = z.infer<typeof ProviderFeed>;

export class MarketplaceFeedClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async providerFeed(providerRef: string, since: string | null): Promise<ProviderFeed> {
    const url = new URL("/api/bai/v1/provider-feed", this.baseUrl);
    url.searchParams.set("provider", providerRef);
    if (since) url.searchParams.set("since", since);
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json", ...signLinkRequest(this.secret, "GET", url.pathname + url.search) },
      signal: AbortSignal.timeout(this.timeoutMs), redirect: "error",
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      throw new Error(res.status === 401 ? `the marketplace refused the link key (${body?.error ?? "no reason given"})`
        : res.status === 404 ? "the marketplace does not offer the provider feed yet, or does not know this provider"
        : res.status === 503 ? "the Business AI link is not set up in the marketplace yet" : `the marketplace answered ${res.status}`);
    }
    const parsed = ProviderFeed.safeParse(body);
    if (!parsed.success) throw new Error(`the marketplace sent data in an unexpected form (${parsed.error.issues[0]?.path.join(".") ?? "?"})`);
    if (parsed.data.provider.ref !== providerRef) throw new Error("the marketplace answered for a different provider");
    return parsed.data;
  }
}

async function ref(tdb: TenantDb, kind: string, externalId: string): Promise<string | null> {
  return (await maybeOne<{ local_id: string }>(tdb, "select local_id from bai_external_refs where source = 'conaro-marketplace' and kind = $1 and external_id = $2", [kind, externalId]))?.local_id ?? null;
}
async function addRef(tdb: TenantDb, kind: string, externalId: string, localId: string) {
  await tdb.query("insert into bai_external_refs (source, kind, external_id, local_id) values ('conaro-marketplace', $1, $2, $3) on conflict do nothing", [kind, externalId, localId]);
}

/** Applies one feed page to one business's records. Idempotent: nothing is imported twice. */
export async function applyProviderFeed(tdb: TenantDb, feed: ProviderFeed): Promise<{ enquiries: number; bookings: number; cancelled: number; completed: number; skipped: string[] }> {
  const out = { enquiries: 0, bookings: 0, cancelled: 0, completed: 0, skipped: [] as string[] };
  for (const r of feed.requests) {
    if (await ref(tdb, "request", r.id)) continue;
    const svc = await maybeOne<{ id: string }>(tdb,
      "select id from bai_services where active and (lower(category) = lower($1) or lower(name) = lower($1)) order by name limit 1", [r.category]);
    const lead = await receiveEnquiry(tdb, {
      name: r.customer?.name ?? `Marketplace customer ${r.id.slice(-6)}`,
      ...(r.customer?.email ? { email: r.customer.email } : {}), ...(r.customer?.phone ? { phone: r.customer.phone } : {}),
      ...(svc ? { serviceId: svc.id } : {}), description: r.description, ...(r.community ? { area: r.community } : {}),
      ...(r.desiredDate ? { desiredDate: r.desiredDate } : {}), channel: "conaro-marketplace", language: r.customer?.language ?? "en-CA",
      expressMarketingConsent: r.expressMarketingConsent && Boolean(r.customer?.email),
    }, "system:marketplace-sync");
    await addRef(tdb, "request", r.id, lead.leadId);
    out.enquiries++;
  }
  for (const b of feed.bookings) {
    const leadId = await ref(tdb, "request", b.requestId);
    if (!leadId) { out.skipped.push(`booking ${b.id}: its request was not in the feed`); continue; }
    const local = await ref(tdb, "booking", b.id);
    if (local) {
      const cur = await one<{ status: string }>(tdb, "select status from bai_bookings where id = $1", [local]);
      if (b.status === "cancelled" && cur.status !== "cancelled") {
        await tdb.query("update bai_bookings set status = 'cancelled', cancel_reason = 'cancelled on the CONARO marketplace' where id = $1", [local]);
        await tdb.query("update bai_jobs set status = 'cancelled' where booking_id = $1 and status <> 'completed'", [local]);
        out.cancelled++;
      } else if (b.status === "completed" && cur.status !== "completed") {
        const job = await maybeOne<{ id: string }>(tdb, "select id from bai_jobs where booking_id = $1 and status <> 'completed'", [local]);
        await tdb.query("update bai_bookings set status = 'completed' where id = $1", [local]);
        if (job) {
          await tdb.query("update bai_jobs set status = 'completed', completed_at = now(), outcome = 'completed on the CONARO marketplace' where id = $1", [job.id]);
          await emitEvent(tdb, "job.completed", { jobId: job.id }, `job.completed:${job.id}`);
        }
        out.completed++;
      } else if (b.status === "scheduled") {
        await tdb.query("update bai_bookings set starts_at = $2, ends_at = $3 where id = $1 and (starts_at <> $2 or ends_at <> $3)", [local, b.startsAt, b.endsAt]);
      }
      continue;
    }
    if (b.status === "cancelled") continue;
    const lead = await one<{ customer_id: string; service_id: string | null; area: string | null; ref: string }>(tdb, "select customer_id, service_id, area, ref from bai_leads where id = $1", [leadId]);
    if (!lead.service_id) { out.skipped.push(`booking ${b.id}: no matching service for enquiry ${lead.ref}`); continue; }
    // The marketplace reveals the customer once booked.
    if (b.customer) {
      await tdb.query("update bai_customers set name = $2, email = coalesce($3, email), phone = coalesce($4, phone), language = $5 where id = $1",
        [lead.customer_id, b.customer.name, b.customer.email?.toLowerCase() ?? null, b.customer.phone, b.customer.language]);
    }
    const { nextRef } = await import("../tenancy.ts");
    const bref = await nextRef(tdb, "booking", "BK");
    const row = await one<{ id: string }>(tdb,
      `insert into bai_bookings (ref, customer_id, service_id, lead_id, starts_at, ends_at, status, confirmed_at, area, source)
       values ($1, $2, $3, $4, $5, $6, $7, now(), $8, 'conaro-marketplace') returning id`,
      [bref, lead.customer_id, lead.service_id, leadId, b.startsAt, b.endsAt, b.status === "completed" ? "completed" : "confirmed", lead.area]);
    await addRef(tdb, "booking", b.id, row.id);
    await tdb.query("update bai_leads set status = 'won', updated_at = now() where id = $1", [leadId]);
    // Confirmed by the marketplace: assignment and the job follow from the usual workflow.
    if (b.status === "scheduled") await emitEvent(tdb, "booking.confirmed", { bookingId: row.id }, `booking.confirmed:${row.id}`);
    out.bookings++;
  }
  return out;
}

/** Reads and applies the feed for one business. Network calls happen outside any database transaction. */
export async function syncMarketplace(db: Db, client: MarketplaceFeedClient, tenantId: string): Promise<{ synced: boolean; detail: string }> {
  const state = await withTenant(db, tenantId, async (tdb) => {
    const t = await one<{ marketplace_provider_ref: string | null; paused: boolean }>(tdb, "select marketplace_provider_ref, paused from bai_tenants");
    const s = await maybeOne<{ cursor: string | null }>(tdb, "select cursor from bai_sync_state where source = 'conaro-marketplace'");
    return { ref: t.marketplace_provider_ref, paused: t.paused, cursor: s?.cursor ?? null };
  });
  if (!state.ref) return { synced: false, detail: "not linked to a marketplace provider" };
  if (state.paused) return { synced: false, detail: "agents paused" };
  let feed: ProviderFeed;
  try {
    feed = await client.providerFeed(state.ref, state.cursor);
    await logExchange(db, "outbound", "marketplace", "/api/bai/v1/provider-feed", true, `${feed.requests.length} requests, ${feed.bookings.length} bookings`);
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError" ? "the marketplace did not answer in time" : (err as Error).message;
    await logExchange(db, "outbound", "marketplace", "/api/bai/v1/provider-feed", false, msg);
    await withTenant(db, tenantId, async (tdb) => {
      await tdb.query(`insert into bai_sync_state (source, last_error) values ('conaro-marketplace', $1)
        on conflict (tenant_id, source) do update set last_error = excluded.last_error, updated_at = now()`, [msg]);
      await tdb.query("update bai_integrations set status = 'error', detail = $1, checked_at = now() where provider = 'conaro-marketplace'", [msg.slice(0, 300)]);
    });
    return { synced: false, detail: msg };
  }
  const result = await withTenant(db, tenantId, async (tdb) => {
    const r = await applyProviderFeed(tdb, feed);
    await tdb.query(`insert into bai_sync_state (source, cursor, last_ok_at) values ('conaro-marketplace', $1, now())
      on conflict (tenant_id, source) do update set cursor = excluded.cursor, last_ok_at = now(), last_error = null, updated_at = now()`, [feed.cursor]);
    await tdb.query("update bai_integrations set status = 'operational', detail = $1, checked_at = now() where provider = 'conaro-marketplace'",
      [`Reading requests and bookings for provider ${feed.provider.ref} (${feed.provider.status}); read-only.`]);
    if (r.enquiries || r.bookings || r.cancelled || r.completed) await tenantAudit(tdb, { actor: "system:marketplace-sync", action: "marketplace.synced", subjectType: "sync", detail: r });
    return r;
  });
  return { synced: true, detail: JSON.stringify(result) };
}
