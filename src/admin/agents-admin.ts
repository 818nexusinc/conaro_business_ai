/** /admin/agents: the platform's own agents, their latest briefings, and the owner's approval queue. */
import type { Db } from "../shared/db.ts";
import { html, table, badge } from "../shared/html.ts";
import type { ReasoningPort } from "../shared/reasoning.ts";
import { PermanentError } from "../shared/errors.ts";
import { adminLayout, csrfField } from "./pages.ts";
import { decideProposal, PLATFORM_AGENTS, runPlatformAgents, type PlatformContext } from "../platform/agents.ts";
import type { AdminExtra } from "./server.ts";

type Finding = { label: string; value: string; kind: string };

export function agentsAdmin(db: Db, reasoning: ReasoningPort, ctx: () => PlatformContext): AdminExtra {
  return async ({ res, path, method, session, form, url }, t) => {
    if (path === "/admin/do/agents-run" && method === "POST") {
      if (!t.can("agents.run")) { t.send(res, 403, "Not allowed for your admin role.", "text/plain"); return true; }
      const r = await runPlatformAgents(db, reasoning, ctx(), `admin:${session.adminId}`);
      const made = r.reduce((a, x) => a + x.proposals, 0); const failed = r.filter((x) => x.outcome === "failed").length;
      t.redirect(res, `/admin/agents?ok=${encodeURIComponent(`Agents ran: ${made} new proposal${made === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`)}`); return true;
    }
    if (path === "/admin/do/proposal" && method === "POST" && form) {
      if (!t.can("proposals.decide")) { t.send(res, 403, "Only an owner can approve agent proposals.", "text/plain"); return true; }
      try {
        const out = await decideProposal(db, session, form.get("id") ?? "", form.get("decision") === "approve" ? "approve" : "reject");
        t.redirect(res, `/admin/agents?ok=${encodeURIComponent(out)}`);
      } catch (err) {
        if (err instanceof PermanentError) { t.redirect(res, `/admin/agents?err=${encodeURIComponent(err.message)}`); return true; }
        throw err;
      }
      return true;
    }
    if (path !== "/admin/agents" || method !== "GET") return false;
    const runs = await db.query<{ agent_id: string; finished_at: string | null; outcome: string; summary: { summary?: string; findings?: Finding[]; error?: string }; simulated: boolean }>(
      "select distinct on (agent_id) agent_id, finished_at, outcome, summary, simulated from bai_platform_agent_runs order by agent_id, id desc");
    const pending = await db.query<{ id: string; agent_id: string; kind: string; title: string; rationale: string; evidence: string[]; payload: Record<string, unknown>; created_at: string }>(
      "select id, agent_id, kind, title, rationale, evidence, payload, created_at from bai_platform_proposals where status = 'pending' order by created_at");
    const decided = await db.query<{ agent_id: string; title: string; status: string; outcome: string | null; decided_at: string; who: string | null }>(
      "select p.agent_id, p.title, p.status, p.outcome, p.decided_at, a.display_name who from bai_platform_proposals p left join bai_platform_admins a on a.id = p.decided_by where p.status <> 'pending' order by p.decided_at desc limit 40");
    const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" }) : "never");
    const name = (id: string) => PLATFORM_AGENTS.find((a) => a.id === id)?.name ?? id;
    const decide = t.can("proposals.decide");
    const KIND: Record<string, string> = { task: "Task for you", "site.copy": "Website wording (draft)", "plans.draft": "Plan change (draft)", "outreach.draft": "Message draft (you send it)" };
    t.page(res, 200, adminLayout(t.ctx(url.searchParams.get("ok"), url.searchParams.get("err")), "Admin agents", html`
<p class="muted">These agents work for CONARO Business AI itself. They read platform figures (counts only, no names or emails) and put proposals here. Approving never publishes or sends anything: website and plan changes become drafts you publish, and messages are drafts a person sends. They also run once a day with the scheduled cycle.</p>
${t.can("agents.run") ? html`<form method="post" action="/admin/do/agents-run">${csrfField(session)}<button type="submit">Run all agents now</button></form>` : ""}
<h2>Waiting for your decision (${pending.length})</h2>
${pending.length ? pending.map((p) => html`<article class="prop"><p class="muted">${badge(KIND[p.kind] ?? p.kind, p.kind === "task" ? "info" : "warn")} ${name(p.agent_id)} · ${when(p.created_at)}</p>
<h3>${p.title}</h3><p>${p.rationale}</p>
${p.evidence.length ? html`<p class="muted small">Based on: ${p.evidence.join(" · ")}</p>` : ""}
${p.kind === "site.copy" ? html`<p><strong>${String(p.payload.key)}:</strong> “${String(p.payload.value)}”</p>` : ""}
${p.kind === "outreach.draft" ? html`<details open><summary>Draft message</summary><p><strong>Subject:</strong> ${String(p.payload.subject)}</p><pre class="json" tabindex="0">${String(p.payload.body)}</pre></details>` : ""}
${decide ? html`<form class="row" method="post" action="/admin/do/proposal">${csrfField(session)}<input type="hidden" name="id" value="${p.id}">
<button name="decision" value="approve" type="submit">${p.kind === "task" ? "Got it" : "Approve"}</button><button class="secondary" name="decision" value="reject" type="submit">Reject</button></form>` : html`<p class="muted">Only an owner can decide.</p>`}
</article>`) : html`<p class="empty">Nothing waiting.</p>`}
<h2>The team</h2>
<div class="grid2">${PLATFORM_AGENTS.map((a) => { const r = runs.find((x) => x.agent_id === a.id); return html`<section class="panel"><h3>${a.name}</h3><p class="muted">${a.role}</p>
<p>${r ? html`${badge(r.outcome, r.outcome === "succeeded" ? "ok" : r.outcome === "failed" ? "bad" : "info")}${r.simulated ? html` ${badge("AI not configured", "muted")}` : ""} <span class="muted">${when(r.finished_at)}</span>` : html`<span class="muted">Not run yet.</span>`}</p>
${r?.summary.summary ? html`<p><strong>${r.summary.summary}</strong></p>` : ""}${r?.summary.error ? html`<p class="error">${r.summary.error}</p>` : ""}
${r?.summary.findings?.length ? html`<dl class="kv">${r.summary.findings.map((f) => html`<dt>${f.label}</dt><dd>${f.value} ${f.kind !== "STATUS" ? badge(f.kind, f.kind === "ACTUAL" ? "ok" : "warn") : ""}</dd>`)}</dl>` : ""}</section>`; })}</div>
<h2>Decided</h2>${table(["When", "Who", "Agent", "Proposal", "Result"], decided.map((d) => [html`${when(d.decided_at)}`, html`${d.who ?? "—"}`, html`${name(d.agent_id)}`, html`${d.title}`, html`${badge(d.status, d.status === "rejected" ? "muted" : "ok")} ${d.outcome ?? ""}`]), "No decisions yet.")}`));
    return true;
  };
}
