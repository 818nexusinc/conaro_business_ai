/** /admin/billing: Stripe configuration status (never the keys), plan ↔ Stripe price links, accounts and events. */
import type { Db } from "../shared/db.ts";
import { html, table, badge } from "../shared/html.ts";
import { billingProblem, keyMode, type StripeConfig } from "../billing/stripe.ts";
import { adminLayout, csrfField } from "./pages.ts";
import { planRows, setStripePrice } from "./plans.ts";
import type { AdminExtra } from "./server.ts";

export function billingAdmin(db: Db, o: { config?: StripeConfig | undefined; publicUrl?: string | undefined }): AdminExtra {
  return async ({ res, path, method, session, form, url }, t) => {
    if (path === "/admin/do/stripe-price" && method === "POST" && form) {
      if (!t.can("billing.manage")) { t.send(res, 403, "Only an owner can change billing.", "text/plain"); return true; }
      const v = (form.get("price_id") ?? "").trim();
      if (v && !/^price_[A-Za-z0-9]{6,80}$/.test(v)) { t.redirect(res, `/admin/billing?err=${encodeURIComponent("A Stripe price id starts with price_.")}`); return true; }
      await setStripePrice(db, session, form.get("plan") ?? "", v || null);
      t.redirect(res, `/admin/billing?ok=${encodeURIComponent(v ? "Plan linked to the Stripe price." : "Plan unlinked from Stripe.")}`); return true;
    }
    if (path !== "/admin/billing" || method !== "GET") return false;
    const problem = billingProblem(o.config);
    const mode = o.config ? keyMode(o.config.secretKey) : null;
    const plans = await planRows(db);
    const accounts = await db.query<{ name: string; plan: string | null; stripe_status: string | null; livemode: boolean; updated_at: string }>(
      "select t.name, a.plan, a.stripe_status, a.livemode, a.updated_at from bai_billing_accounts a join bai_tenants t on t.id = a.tenant_id order by a.updated_at desc limit 100");
    const events = await db.query<{ type: string; livemode: boolean; outcome: string; received_at: string }>("select type, livemode, outcome, received_at from bai_billing_events order by received_at desc limit 50");
    const when = (v: string) => new Date(v).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" });
    const hook = `${(o.publicUrl ?? "https://<your-domain>").replace(/\/$/, "")}/api/billing/stripe/webhook`;
    const manage = t.can("billing.manage");
    t.page(res, 200, adminLayout(t.ctx(url.searchParams.get("ok"), url.searchParams.get("err")), "Billing (Stripe)", html`
<section class="panel"><h2>Connection</h2>
<dl class="kv"><dt>Status</dt><dd>${problem ? badge("not ready", "warn") : mode === "test" ? badge("test mode: no real money", "info") : badge("live: real charges", "bad")}</dd>
<dt>Secret key</dt><dd>${o.config?.secretKey ? `set (${mode ?? "unrecognised"} key)` : "not set (STRIPE_SECRET_KEY)"}</dd>
<dt>Webhook secret</dt><dd>${o.config?.webhookSecret ? "set" : "not set (STRIPE_WEBHOOK_SECRET)"}</dd>
<dt>Live charging</dt><dd>${o.config?.liveApprovedBy ? `approved by ${o.config.liveApprovedBy}` : "not approved: live keys and live events are refused"}</dd>
<dt>Webhook address</dt><dd><code>${hook}</code></dd></dl>
${problem ? html`<p class="error">${problem}</p>` : ""}
<details><summary>How to connect Stripe (test mode)</summary><ol>
<li>In the Stripe Dashboard (test mode), create a Product for each plan with a monthly recurring Price in CAD.</li>
<li>Add <code>STRIPE_SECRET_KEY</code> (a <code>sk_test_…</code> or restricted <code>rk_test_…</code> key) to the host's environment variables. Keys are never stored in the database or shown here.</li>
<li>Add a webhook endpoint for the address above with the events <code>checkout.session.completed</code>, <code>customer.subscription.updated</code>, <code>customer.subscription.deleted</code>, <code>invoice.paid</code> and <code>invoice.payment_failed</code>, then set its signing secret as <code>STRIPE_WEBHOOK_SECRET</code>. Redeploy.</li>
<li>Paste each plan's Stripe price id below. Owners then see "Subscribe with a card" on their Plan page.</li>
<li>Real charging stays off until the owner sets <code>BAI_STRIPE_LIVE_APPROVED_BY</code> and switches to live keys.</li></ol></details></section>
<section class="panel"><h2>Plans linked to Stripe prices</h2>${table(["Plan", "Live price", "Stripe price id", ""], plans.map((p) => [html`${p.published.name.en}`,
      html`${p.published.priceCents === null ? "not announced" : `$${(p.published.priceCents / 100).toFixed(2)} / month`}`, html`<code>${p.published.stripePriceId ?? "—"}</code>`,
      manage ? html`<form class="row" method="post" action="/admin/do/stripe-price">${csrfField(session)}<input type="hidden" name="plan" value="${p.id}"><input name="price_id" aria-label="Stripe price id for ${p.published.name.en}" placeholder="price_…" value="${p.published.stripePriceId ?? ""}" size="28"><button class="secondary small" type="submit">Save</button></form>` : html``]))}
<p class="muted">Make sure the Stripe price matches the published price; Stripe charges the amount set on its price.</p></section>
<section class="panel"><h2>Billing accounts</h2>${table(["Business", "Plan", "Stripe status", "Mode", "Updated"], accounts.map((a) => [html`${a.name}`, html`${a.plan ?? "—"}`, html`${a.stripe_status ?? "—"}`, html`${a.livemode ? "live" : "test"}`, html`${when(a.updated_at)}`]), "No business has subscribed yet.")}</section>
<section class="panel"><h2>Recent Stripe events</h2>${table(["Received", "Event", "Mode", "Outcome"], events.map((e) => [html`${when(e.received_at)}`, html`<code>${e.type}</code>`, html`${e.livemode ? "live" : "test"}`, html`${e.outcome}`]), "No events received yet.")}</section>`));
    return true;
  };
}
