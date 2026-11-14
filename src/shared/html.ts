/** Tiny HTML builder. Every interpolated value goes through esc() unless it is already Html. */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export const raw = (s: string) => new Html(s);

export function badge(text: string, tone: "ok" | "warn" | "bad" | "info" | "muted" = "muted"): Html {
  return html`<span class="badge ${tone}">${text}</span>`;
}

const STATUS_TONES: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  succeeded: "ok", approved: "ok", executed: "ok", active: "ok", resolved: "ok",
  queued: "info", running: "info", pending: "warn", awaiting_approval: "warn", approval_pending: "warn",
  changes_requested: "warn", simulated: "info", warning: "warn", open: "warn",
  failed: "bad", dead: "bad", rejected: "bad", blocked: "bad", critical: "bad", expired: "muted", cancelled: "muted",
};
export const statusBadge = (status: string) => badge(status.replaceAll("_", " "), STATUS_TONES[status] ?? "muted");

export function table(headers: string[], rows: Html[][], empty = "Nothing to show yet."): Html {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  // Focusable and labelled so keyboard users can scroll wide tables (WCAG 2.1.1; axe scrollable-region-focusable).
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${`Table: ${headers.filter(Boolean).slice(0, 3).join(", ")}`}"><table><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
<tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" });
}

export function jsonBlock(value: unknown): Html {
  return html`<pre class="json" tabindex="0">${JSON.stringify(value, null, 2)}</pre>`;
}
