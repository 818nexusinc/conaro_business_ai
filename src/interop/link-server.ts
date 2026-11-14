import type { Db } from "../shared/db.ts";
import { verifyLinkRequest } from "./protocol.ts";

export type Peer = "marketplace" | "bos";

/** Logs a signed exchange (no bodies, no secrets). Best effort. */
export async function logExchange(db: Db, direction: "inbound" | "outbound", peer: Peer, endpoint: string, ok: boolean, detail: string): Promise<void> {
  await db.query("insert into bai_link_exchanges (direction, peer, endpoint, ok, detail) values ($1, $2, $3, $4, $5)",
    [direction, peer, endpoint.split("?")[0]!.slice(0, 200), ok, detail.slice(0, 300)]).catch(() => undefined);
}

/**
 * Verifies a signed inbound request: signature, freshness and a one-time code that has never been
 * seen (replay protection). Codes older than a day are forgotten (requests are only valid for 5 minutes).
 */
export async function verifyInbound(db: Db, secret: string | undefined, peer: Peer, req: { method: string; pathAndQuery: string; headers: Record<string, string | undefined>; body?: string }):
  Promise<{ ok: true } | { ok: false; status: 401 | 503; reason: string }> {
  if (!secret) return { ok: false, status: 503, reason: `the ${peer} link is not set up in CONARO Business AI` };
  const check = verifyLinkRequest(secret, req);
  if (!check.ok) {
    await logExchange(db, "inbound", peer, req.pathAndQuery, false, check.reason);
    return check;
  }
  await db.query("delete from bai_link_nonces where seen_at < now() - interval '1 day'");
  const fresh = await db.query("insert into bai_link_nonces (nonce) values ($1) on conflict do nothing returning nonce", [`${peer}:${check.nonce}`]);
  if (!fresh.length) {
    await logExchange(db, "inbound", peer, req.pathAndQuery, false, "one-time code reused");
    return { ok: false, status: 401, reason: "the request was already used (replay refused)" };
  }
  await logExchange(db, "inbound", peer, req.pathAndQuery, true, "ok");
  return { ok: true };
}
