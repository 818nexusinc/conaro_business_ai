/**
 * Stripe subscription billing for CONARO Business AI plans.
 *
 * Verified against Stripe's documentation (docs/REFERENCE_CHECKS.md R68–R71):
 *  - Checkout Sessions: POST https://api.stripe.com/v1/checkout/sessions, form-encoded, `mode=subscription`
 *    ("Pass subscription if the Checkout Session includes at least one recurring item"), `line_items[0][price]`,
 *    `success_url`, `cancel_url`, `client_reference_id`; the response's `url` is where the customer pays
 *    ("Redirect customers to this URL to take them to Checkout").
 *  - Customer portal: POST https://api.stripe.com/v1/billing_portal/sessions with `customer` and `return_url`.
 *  - Webhooks: the `Stripe-Signature` header carries `t=<timestamp>` and one or more `v1=<hex>`; the expected
 *    signature is HMAC-SHA256(secret, `${t}.${rawBody}`), compared in constant time, with a 5-minute tolerance.
 *  - Keys: sandbox keys start with `sk_test_` / `rk_test_`, live keys with `sk_live_` / `rk_live_`.
 *
 * Real charging is a hard limit of this project: live keys are refused unless the owner has recorded their
 * approval in BAI_STRIPE_LIVE_APPROVED_BY. Until then everything runs in Stripe test mode (no real money).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { PermanentError } from "../shared/errors.ts";

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_VERSION = "2026-10-28.endive";

export type StripeMode = "test" | "live";
export function keyMode(key: string): StripeMode | null {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return "test";
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) return "live";
  return null;
}

export interface StripeConfig { secretKey: string; webhookSecret?: string | undefined; liveApprovedBy?: string | undefined }

/** Checks the configuration; returns why billing cannot run, or null when it can. */
export function billingProblem(cfg: StripeConfig | undefined): string | null {
  if (!cfg?.secretKey) return "Stripe is not configured (STRIPE_SECRET_KEY).";
  const mode = keyMode(cfg.secretKey);
  if (!mode) return "STRIPE_SECRET_KEY is not a Stripe secret or restricted key.";
  if (mode === "live" && !cfg.liveApprovedBy) return "A live Stripe key is set but real charging has not been approved (BAI_STRIPE_LIVE_APPROVED_BY). Use a test key.";
  return null;
}

/** Stripe's form encoding: nested keys as a[b][0][c]=value. */
export function formEncode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item !== null ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") formEncode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface StripeClient {
  mode: StripeMode;
  createCheckoutSession(p: { priceId: string; tenantId: string; plan: string; email?: string | undefined; successUrl: string; cancelUrl: string; customer?: string | undefined }): Promise<{ id: string; url: string; livemode: boolean }>;
  createPortalSession(p: { customer: string; returnUrl: string }): Promise<{ url: string }>;
}

export function stripeClient(cfg: StripeConfig, fetchImpl: Fetch = fetch as unknown as Fetch): StripeClient {
  const problem = billingProblem(cfg);
  if (problem) throw new PermanentError(problem);
  const mode = keyMode(cfg.secretKey)!;
  async function post<T>(path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": STRIPE_VERSION,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const r = await fetchImpl(`${STRIPE_API}${path}`, { method: "POST", headers, body: formEncode(params).toString() });
    const body = await r.json().catch(() => ({})) as { error?: { message?: string } } & T;
    // Stripe's own error message is safe to show (it never contains the key).
    if (!r.ok) throw new PermanentError(`Stripe refused the request: ${body.error?.message ?? `HTTP ${r.status}`}`);
    return body;
  }
  return {
    mode,
    async createCheckoutSession(p) {
      const s = await post<{ id: string; url: string; livemode: boolean }>("/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl, cancel_url: p.cancelUrl,
        client_reference_id: p.tenantId,
        ...(p.customer ? { customer: p.customer } : p.email ? { customer_email: p.email } : {}),
        metadata: { tenant_id: p.tenantId, plan: p.plan },
        subscription_data: { metadata: { tenant_id: p.tenantId, plan: p.plan } },
      });
      if (!s.url || !s.url.startsWith("https://")) throw new PermanentError("Stripe did not return a checkout address.");
      if (s.livemode && mode !== "live") throw new PermanentError("Stripe answered in live mode with a test key; refusing.");
      return s;
    },
    async createPortalSession(p) {
      const s = await post<{ url: string }>("/v1/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl });
      if (!s.url?.startsWith("https://")) throw new PermanentError("Stripe did not return a portal address.");
      return s;
    },
  };
}

/** Verifies a webhook delivery. Returns the parsed event, or throws. */
export function verifyWebhook(rawBody: string, header: string | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): { id: string; type: string; livemode: boolean; data: { object: Record<string, unknown> } } {
  if (!header) throw new PermanentError("missing Stripe-Signature header");
  if (toleranceSeconds <= 0) throw new Error("tolerance must be positive");
  let t: number | null = null; const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("="); const v = rest.join("=");
    if (k?.trim() === "t") t = Number(v);
    if (k?.trim() === "v1") v1.push(v.trim());
  }
  if (t === null || !Number.isFinite(t) || v1.length === 0) throw new PermanentError("malformed Stripe-Signature header");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex"));
  const match = v1.some((s) => { const b = Buffer.from(s); return b.length === expected.length && timingSafeEqual(b, expected); });
  if (!match) throw new PermanentError("signature does not match");
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new PermanentError("timestamp outside the tolerance");
  const event = JSON.parse(rawBody) as { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } };
  if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object") throw new PermanentError("not a Stripe event");
  return { id: event.id, type: event.type, livemode: event.livemode === true, data: { object: event.data.object as Record<string, unknown> } };
}

/** Signs a payload the way Stripe does (tests and local tooling only). */
export function signForTest(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
}
