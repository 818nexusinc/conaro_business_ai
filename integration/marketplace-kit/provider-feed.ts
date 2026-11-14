/**
 * MARKETPLACE KIT — the marketplace's side of the Business AI link, ready to copy into
 * 818nexusinc/nexus-marketplace. It is framework-independent: a Next.js route handler only has to
 * pass the request in, implement `ProviderFeedPort` against the marketplace's own tables, and return
 * the result. Contract: docs/INTEROP.md §2–3. Tested end to end against Business AI in
 * tests/marketplace-kit.test.ts.
 *
 * In the marketplace, import the protocol from its existing copy (src/lib/link-protocol.ts), which is
 * identical to ../../src/interop/protocol.ts.
 */
import { createHmac, randomBytes } from "node:crypto";
import { verifyLinkRequest } from "../../src/interop/protocol.ts";

/** One request the provider received. `customer` stays null until the request is booked. */
export interface FeedRequest {
  id: string; createdAt: string; category: string; community: string | null; description: string; desiredDate: string | null;
  customer: FeedCustomer | null; expressMarketingConsent: boolean;
}
export interface FeedBooking { id: string; requestId: string; status: "scheduled" | "completed" | "cancelled"; startsAt: string; endsAt: string; customer: FeedCustomer | null }
export interface FeedCustomer { name: string; email: string | null; phone: string | null; language: "en-CA" | "fr-CA" }

/** What the marketplace implements against its database (read-only queries). */
export interface ProviderFeedPort {
  /** The provider's status, or null when the marketplace does not know it. */
  providerStatus(providerRef: string): Promise<"pending" | "active" | "suspended" | null>;
  /**
   * Requests sent to this provider and this provider's bookings that changed after `after`
   * (exclusive; null = from the beginning), oldest first, at most `limit` of each. Each item carries
   * `changedAt` (ISO time, from the row's updated/created timestamp) and its id, used for the cursor.
   */
  requestsChangedAfter(providerRef: string, after: Cursor | null, limit: number): Promise<(FeedRequest & { changedAt: string })[]>;
  bookingsChangedAfter(providerRef: string, after: Cursor | null, limit: number): Promise<(FeedBooking & { changedAt: string })[]>;
  /** Records a one-time code; false when it was already used (replay). Keep codes for at least 10 minutes. */
  useNonce(nonce: string): Promise<boolean>;
}

export interface Cursor { requests: { at: string; id: string } | null; bookings: { at: string; id: string } | null }
export const PAGE_LIMIT = 500;

export function encodeCursor(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString("base64url"); }
export function decodeCursor(s: string | null): Cursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    return v && typeof v === "object" && "requests" in v && "bookings" in v ? v : null;
  } catch { return null; }
}

export type FeedResponse = { status: number; body: unknown };

/**
 * GET /api/bai/v1/provider-feed?provider=<ref>&since=<cursor>
 * `secret` is the marketplace's saved Business AI key (null/undefined when none is saved).
 */
export async function handleProviderFeed(
  req: { method: string; pathAndQuery: string; headers: Record<string, string | undefined> },
  secret: string | null | undefined,
  port: ProviderFeedPort,
): Promise<FeedResponse> {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  if (!secret) return { status: 503, body: { error: "no Business AI link key is saved" } };
  const check = verifyLinkRequest(secret, req);
  if (!check.ok) return { status: 401, body: { error: check.reason } };
  if (!(await port.useNonce(`bai:${check.nonce}`))) return { status: 401, body: { error: "the request was already used" } };
  const url = new URL(req.pathAndQuery, "http://marketplace.local");
  const provider = url.searchParams.get("provider") ?? "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(provider)) return { status: 400, body: { error: "provider is required" } };
  const status = await port.providerStatus(provider);
  if (!status) return { status: 404, body: { error: "unknown provider" } };
  const since = decodeCursor(url.searchParams.get("since"));
  const [requests, bookings] = await Promise.all([
    port.requestsChangedAfter(provider, since, PAGE_LIMIT),
    port.bookingsChangedAfter(provider, since, PAGE_LIMIT),
  ]);
  const last = <T extends { changedAt: string; id: string }>(list: T[], prev: { at: string; id: string } | null) =>
    list.length ? { at: list[list.length - 1]!.changedAt, id: list[list.length - 1]!.id } : prev;
  const cursor = encodeCursor({ requests: last(requests, since?.requests ?? null), bookings: last(bookings, since?.bookings ?? null) });
  const strip = <T extends { changedAt: string }>({ changedAt: _c, ...rest }: T) => rest;
  return {
    status: 200,
    body: {
      version: 1, provider: { ref: provider, status }, cursor,
      // Privacy: never send a customer on a request that is not booked, whatever the port returned.
      requests: requests.map(strip).map((r) => ({ ...r, customer: null })),
      bookings: bookings.map(strip),
    },
  };
}

/** The "Open Business AI" button's address for a signed-in provider (token valid 2 minutes, once). */
export function businessAiSignInUrl(businessAiBaseUrl: string, secret: string, providerRef: string, email: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ v: 1, providerRef, email: email.trim().toLowerCase(), exp: Math.floor(now / 1000) + 120, nonce: randomBytes(18).toString("base64url") })).toString("base64url");
  const token = `${body}.${createHmac("sha256", secret).update(`bai-sso\n${body}`).digest("base64url")}`;
  const url = new URL("/sso", businessAiBaseUrl);
  url.searchParams.set("t", token);
  return url.toString();
}
