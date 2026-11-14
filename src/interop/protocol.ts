import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The CONARO link: how the marketplace and the operating system prove to each other who is calling.
 *
 * Both sides hold the same secret (BOS_LINK_SECRET here; the marketplace keeps it encrypted in its
 * platform_secrets). Every request carries a timestamp, a one-time nonce and an HMAC-SHA256 signature over
 *   METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA256(BODY)
 * Requests older than 5 minutes, with a reused nonce or a wrong signature are refused.
 * The same file exists in the marketplace (src/lib/link-protocol.ts); tests on both sides use the same vector.
 *
 * Everything sent over the link is read-only: neither side can change the other's data through it.
 */
export const LINK_VERSION = 1;
export const LINK_HEADERS = { timestamp: "x-conaro-link-timestamp", nonce: "x-conaro-link-nonce", signature: "x-conaro-link-signature" } as const;
export const LINK_MAX_SKEW_SECONDS = 300;
export const LINK_MIN_SECRET_LENGTH = 32;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function linkCanonical(method: string, pathAndQuery: string, timestamp: string, nonce: string, body = ""): string {
  return [method.toUpperCase(), pathAndQuery, timestamp, nonce, sha256(body)].join("\n");
}

export function linkSignature(secret: string, method: string, pathAndQuery: string, timestamp: string, nonce: string, body = ""): string {
  return "v1=" + createHmac("sha256", secret).update(linkCanonical(method, pathAndQuery, timestamp, nonce, body)).digest("hex");
}

/** Headers for a signed request. */
export function signLinkRequest(secret: string, method: string, pathAndQuery: string, body = "", now = Date.now(), nonce = randomBytes(18).toString("base64url")): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  return { [LINK_HEADERS.timestamp]: timestamp, [LINK_HEADERS.nonce]: nonce, [LINK_HEADERS.signature]: linkSignature(secret, method, pathAndQuery, timestamp, nonce, body) };
}

export type LinkCheck = { ok: true; nonce: string } | { ok: false; status: 401; reason: string };

/** Checks the signature and freshness. The caller then records the nonce once (replay protection). */
export function verifyLinkRequest(secret: string, req: { method: string; pathAndQuery: string; headers: Record<string, string | undefined>; body?: string }, now = Date.now()): LinkCheck {
  const timestamp = req.headers[LINK_HEADERS.timestamp];
  const nonce = req.headers[LINK_HEADERS.nonce];
  const signature = req.headers[LINK_HEADERS.signature];
  if (!timestamp || !nonce || !signature) return { ok: false, status: 401, reason: "the request is not signed" };
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > LINK_MAX_SKEW_SECONDS) return { ok: false, status: 401, reason: "the request is more than 5 minutes old (or the clocks differ)" };
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce)) return { ok: false, status: 401, reason: "the request has an invalid one-time code" };
  const expected = Buffer.from(linkSignature(secret, req.method, req.pathAndQuery, timestamp, nonce, req.body ?? ""));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401, reason: "the signature does not match: the two systems hold different link keys" };
  return { ok: true, nonce };
}

/** Lower-case, trimmed email → SHA-256. Lets both sides match businesses without sending addresses. */
export const emailHash = (email: string) => sha256(email.trim().toLowerCase());
