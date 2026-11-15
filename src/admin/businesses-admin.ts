/**
 * /admin/businesses: every workspace on the platform (name, industry, plan, status, billing), with the platform
 * owner's emergency switch to pause or resume all of a business's agents. Business records stay with the
 * business: this page reads only workspace-level fields.
 */
import type { Db } from "../shared/db.ts";
import { html, table, badge } from "../shared/html.ts";
import { withTenant } from "../tenancy.ts";
import { setPaused } from "../tenants.ts";
import { adminAudit } from "./auth.ts";
import { adminLayout, csrfField } from "./pages.ts";
import type { AdminExtra } from "./server.ts";

export function businessesAdmin(db: Db): AdminExtra {
  return async ({ res, path, method, session, form, url }, t) => {
    if (path === "/admin/do/business-pause" && method === "POST" && form) {
      if (!t.can("businesses.manage")) { t.send(res, 403, "Only an owner can pause or resume a business.", "text/plain"); return true; }
      const id = form.get("id") ?? ""; const pause = form.get("pause") === "yes";
      if (!/^[0-9a-f-]{36}$/.test(id) || !(await db.query("select 1 from bai_tenants where id = $1", [id])).length) { t.redirect(res, "/admin/businesses?err=Unknown%20business"); return true; }
      const reason = (form.get("reason") ?? "").slice(0, 200) || (pause ? "paused by CONARO platform admin" : "resumed");
      await withTenant(db, id, (tdb) => setPaused(tdb, pause, reason, `platform-admin:${session.adminId}`));
      await adminAudit(db, { adminId: session.adminId, actor: `admin:${session.adminId}`, action: pause ? "business.paused" : "business.resumed", subject: id, detail: { reason } });
      t.redirect(res, `/admin/businesses?ok=${encodeURIComponent(pause ? "All of that business's agents are paused." : "That business's agents are running again.")}`); return true;
    }
    if (path !== "/admin/businesses" || method !== "GET") return false;
    const rows = await db.query<{ id: string; name: string; industry: string; status: string; paused: boolean; is_demo: boolean; created_at: string; plan: string | null; sub_status: string | null; billing_status: string | null }>(
      `select t.id, t.name, t.industry, t.status, t.paused, t.is_demo, t.created_at, s.plan, s.status sub_status, s.billing_status
       from bai_tenants t left join bai_subscriptions s on s.tenant_id = t.id order by t.created_at desc limit 300`);
    const manage = t.can("businesses.manage");
    t.page(res, 200, adminLayout(t.ctx(url.searchParams.get("ok"), url.searchParams.get("err")), "Businesses", html`
<p class="muted">Every workspace on the platform. A business's own records (customers, jobs, money) stay in its workspace and are not shown here. Pausing stops all of its agents at once; the owner sees why and can ask you to resume.</p>
${table(["Business", "Industry", "Plan", "Subscription", "Billing", "Agents", "Joined", ""], rows.map((r) => [
      html`<strong>${r.name}</strong>${r.is_demo ? html` ${badge("demo", "muted")}` : ""}`, html`${r.industry}`, html`${r.plan ?? "—"}`,
      html`${r.sub_status ?? "—"}`, html`${(r.billing_status ?? "—").replaceAll("_", " ")}`, r.paused ? badge("paused", "warn") : badge("running", "ok"),
      html`${new Date(r.created_at).toLocaleDateString("en-CA", { timeZone: "America/Moncton" })}`,
      manage && r.status !== "cancelled" ? html`<form method="post" action="/admin/do/business-pause">${csrfField(session)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="pause" value="${r.paused ? "no" : "yes"}">
        <button class="secondary small" type="submit">${r.paused ? "Resume agents" : "Pause agents"}</button></form>` : html``]), "No businesses yet.")}`));
    return true;
  };
}
