/** /admin/plans: plan names, monthly prices and features (English and French), drafts → publish. */
import type { Db } from "../shared/db.ts";
import { html, table, badge } from "../shared/html.ts";
import { billableAgents } from "../catalog/plans.ts";
import { adminLayout, csrfField } from "./pages.ts";
import { planHistory, planRows, publishPlans, savePlanDraft, settingsFromForm, type PlanSettings } from "./plans.ts";
import type { AdminExtra } from "./server.ts";

const dollars = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(/\.00$/, ""));
const shown = (s: PlanSettings) => (s.priceCents === null ? "Not announced" : `$${dollars(s.priceCents)} / month`);

export function plansAdmin(db: Db): AdminExtra {
  return async ({ res, path, method, session, form, url }, t) => {
    if (path === "/admin/do/plan" && method === "POST" && form) {
      if (!t.can("plans.edit")) { t.send(res, 403, "Only an owner can change plans and pricing.", "text/plain"); return true; }
      const id = form.get("plan") ?? "";
      const row = (await planRows(db)).find((r) => r.id === id);
      if (!row) { t.redirect(res, "/admin/plans?err=Unknown%20plan"); return true; }
      await savePlanDraft(db, session, id, settingsFromForm(form, row.draft));
      t.redirect(res, `/admin/plans?ok=${encodeURIComponent(`Draft saved for ${row.draft.name.en}. Publish to show it on the website.`)}`); return true;
    }
    if (path === "/admin/do/plans-publish" && method === "POST") {
      if (!t.can("plans.publish")) { t.send(res, 403, "Only an owner can publish pricing.", "text/plain"); return true; }
      const n = await publishPlans(db, session);
      t.redirect(res, `/admin/plans?ok=${encodeURIComponent(`Published ${n} plan${n === 1 ? "" : "s"}.`)}`); return true;
    }
    if (path !== "/admin/plans" || method !== "GET") return false;
    const rows = await planRows(db);
    const edit = t.can("plans.edit");
    const history = await planHistory(db);
    const pending = rows.filter((r) => r.changed).length;
    t.page(res, 200, adminLayout(t.ctx(url.searchParams.get("ok"), url.searchParams.get("err")), "Plans and pricing", html`
<p class="muted">Prices are monthly, in Canadian dollars, before tax. Leave the price blank to keep "Price announced before billing starts" on the website. Drafts become visible on the website, the sign-up form and every business's "Plan and usage" page only after you publish.</p>
${pending && edit ? html`<form class="notice" method="post" action="/admin/do/plans-publish">${csrfField(session)}<strong>${pending} plan${pending === 1 ? "" : "s"} waiting to publish.</strong> <button type="submit">Publish pricing</button></form>` : ""}
<div class="grid2">${rows.map((r) => html`<section class="panel"><h2>${r.draft.name.en} <span class="muted">/ ${r.draft.name.fr}</span> ${r.changed ? badge("draft", "warn") : badge("published", "ok")}</h2>
<dl class="kv"><dt>Live price</dt><dd>${shown(r.published)}</dd><dt>Working agents</dt><dd>${billableAgents(r.id).length}</dd><dt>Stripe price</dt><dd>${r.published.stripePriceId ?? "not linked (Billing)"}</dd></dl>
${edit ? html`<form class="stack" method="post" action="/admin/do/plan">${csrfField(session)}<input type="hidden" name="plan" value="${r.id}"><input type="hidden" name="_back" value="/admin/plans">
<label>Monthly price, CAD before tax (blank = not announced) <input name="price" inputmode="decimal" value="${dollars(r.draft.priceCents)}" placeholder="e.g. 149"></label>
<label>Name (English) <input name="name_en" required maxlength="40" value="${r.draft.name.en}"></label>
<label>Name (French) <input name="name_fr" required maxlength="40" value="${r.draft.name.fr}"></label>
<label>Features (English, one per line, up to 8) <textarea name="features_en" rows="4">${r.draft.features.en.join("\n")}</textarea></label>
<label>Features (French, one per line) <textarea name="features_fr" rows="4">${r.draft.features.fr.join("\n")}</textarea></label>
<label><input type="checkbox" name="recommended" value="yes"${r.draft.recommended ? html` checked` : ""}> Highlight as the recommended plan</label>
<button type="submit">Save draft</button></form>` : html`<p class="muted">Only an owner can edit plans.</p>`}</section>`)}</div>
<section class="panel"><h2>History</h2>${table(["When", "Who", "What", "Plan", "Price"], history.map((h) => [
      html`${new Date(h.occurred_at).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" })}`, html`${h.who ?? "—"}`,
      badge(h.action, h.action === "publish" ? "ok" : "info"), html`${h.plan_id}`, html`${shown(h.value)}`]), "No changes yet.")}</section>`));
    return true;
  };
}
