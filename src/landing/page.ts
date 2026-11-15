import { html, raw, type Html } from "../shared/html.ts";
import { PLANS, billableAgents, isEntitled, type Plan } from "../catalog/plans.ts";
import { INDUSTRY_PACKS } from "../catalog/industries.ts";
import { agentDef } from "../catalog/agents.ts";
import { HTML_LANG, type Lang } from "../i18n.ts";
import { AGENT_COPY, DEPTS, type AgentCopy, type Dept } from "./agents-copy.ts";
import { COPY, INDUSTRY_FR, PLAN_FEATURES_FR, PLAN_NAME_FR, SIGNUP_ERRORS_FR } from "./copy.ts";
import { MARKETING_CONSENT_WORDING, MARKETING_CONSENT_WORDING_FR } from "./signup.ts";
import { seconds } from "./presenters.ts";
import { NARRATION } from "./narration.ts";
import { AGENT_PHOTO, CREDITS, DAY_PHOTOS, HERO_VIDEO, TRADE_PHOTO, type Photo } from "./media.ts";

export interface LandingOptions {
  lang: Lang;
  /** Explainer videos: <base>/<lang>/<agent>.mp4 with poster <agent>.jpg. */
  videoBase?: string | undefined;
  /** Recorded narration (natural human voice): <base>/<lang>/<agent>.mp3. */
  audioBase?: string | undefined;
  signupOpen: boolean;
  /** Name of the fluent reviewer who approved the French copy; until set, French pages say it is under review. */
  frReviewedBy?: string | undefined;
  plan?: string | undefined;
  error?: string | undefined;
  values?: Record<string, string> | undefined;
  /** Published (or, in the editor, draft) overrides of the built-in text for this language: key → text. */
  content?: Record<string, string> | undefined;
  /** Admin editor: marks every editable text and image, and loads the editor's toolbar. */
  editing?: { csrf: string; pending: number; canPublish: boolean } | undefined;
  /** Published plan prices and names (admin-managed); without them the built-in catalogue is used. */
  plans?: Record<string, { priceCents: number | null; name: Record<Lang, string>; features: Record<Lang, string[]>; recommended: boolean }> | undefined;
}

/** Text that the admin may override. In the editor it is wrapped so it can be clicked and edited in place. */
function T(o: LandingOptions, key: string, fallback: string): Html {
  const v = o.content?.[key] ?? fallback;
  return o.editing ? html`<span class="ed" data-edit="${key}">${v}</span>` : html`${v}`;
}
/** The same override as plain text (for attributes, labels repeated elsewhere). */
const S = (o: LandingOptions, key: string, fallback: string): string => o.content?.[key] ?? fallback;
/** A photo the admin may replace with an uploaded image ("u:<id>" served from the database). */
function photoFor(o: LandingOptions, key: string, p: Photo): Photo & { key: string; src?: string } {
  const v = o.content?.[key];
  return v && /^u:[0-9a-f-]{36}$/.test(v) ? { ...p, src: `/media/u/${v.slice(2)}`, key } : { ...p, key };
}
const agentText = (o: LandingOptions, a: AgentCopy, field: "name" | "summary") => S(o, `agent.${a.id}.${field}`, a[field][o.lang]);
const SECTIONS = ["team", "day", "plans", "faq"] as const;
type SectionId = (typeof SECTIONS)[number];
/** Section order and visibility (admin "layout" setting); unknown or missing sections fall back to the default. */
export function layoutOf(raw: string | undefined): { order: SectionId[]; hidden: SectionId[] } {
  try {
    const l = raw ? JSON.parse(raw) as { order?: unknown; hidden?: unknown } : {};
    const order = (Array.isArray(l.order) ? l.order : []).filter((x): x is SectionId => SECTIONS.includes(x as SectionId));
    for (const id of SECTIONS) if (!order.includes(id)) order.push(id);
    const hidden = (Array.isArray(l.hidden) ? l.hidden : []).filter((x): x is SectionId => SECTIONS.includes(x as SectionId));
    return { order: [...new Set(order)], hidden };
  } catch { return { order: [...SECTIONS], hidden: [] }; }
}

const svg = (path: string) => html`<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const ICON = {
  check: "M5 12.5l4.5 4.5L19 7.5", play: "M8 5l11 7-11 7z", pause: "M8 5v14M16 5v14", arrow: "M5 12h14M13 6l6 6-6 6",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  auto: "M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 100 8 4 4 0 000-8z", prev: "M19 12H5M11 6l-6 6 6 6",
  manage: "M12 3l2.6 5.6 6 .6-4.5 4 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.5-4 6-.6z", front: "M4 5h16v11H9l-5 4z", jobs: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4",
  money: "M12 3v18M16 7.5c0-1.9-1.8-3-4-3s-4 1.1-4 3 1.8 2.6 4 3 4 1.1 4 3-1.8 3-4 3-4-1.1-4-3", growth: "M3 17l6-6 4 4 8-8M15 7h6v6", office: "M3 6h6l2 2h10v11H3z", rules: "M4 6h16M4 12h10M4 18h6M17 15l2 2 3-4", ok: "M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6l7-3zM9 12l2 2 4-4",
};
const planName = (o: LandingOptions, p: Plan) => o.plans?.[p.id]?.name[o.lang] ?? (o.lang === "fr" ? PLAN_NAME_FR[p.id] ?? p.name : p.name);
const agentName = (lang: Lang, id: string) => AGENT_COPY.find((a) => a.id === id)?.name[lang] ?? agentDef(id).name.replace(/^AI /, "");

/** A responsive photo: 640 and 1280 px versions (JPEG, served from /media), lazy unless it is above the fold. */
function img(p: Photo & { src?: string; key?: string }, lang: Lang, cls = "", eager = false, editing = false): Html {
  const media = editing && p.key ? html` data-edit-media="${p.key}"` : "";
  const lazy = eager ? html` fetchpriority="high"` : html` loading="lazy" decoding="async"`;
  if (p.src) return html`<img class="${cls}" src="${p.src}" width="${p.w}" height="${p.h}" alt="${p.alt[lang]}"${lazy}${media}>`;
  return html`<img class="${cls}" src="/media/${p.file}-1280.jpg" srcset="/media/${p.file}-640.jpg 640w, /media/${p.file}-1280.jpg 1280w" sizes="(min-width: 900px) 50vw, 100vw"
    width="${p.w}" height="${p.h}" alt="${p.alt[lang]}"${lazy}${media}>`;
}

/**
 * A presenter: a recorded video when one exists, otherwise a photo of the work it handles, speaking the script
 * (recorded narration if present, else the device's most natural voice, chosen by /static/landing.js) with
 * live captions. Without JavaScript the full script is shown.
 */
function player(o: LandingOptions, key: string, name: string, lines: string[], photo: Photo & { src?: string; key?: string }, cls = "", badge?: Html): Html {
  const c = COPY[o.lang].player;
  const vb = o.videoBase?.replace(/\/$/, "");
  // Recorded narration: the configured folder, else the AI-voice files that ship with the site (public/audio).
  const ab = o.audioBase?.replace(/\/$/, "") ?? (NARRATION[o.lang][key] ? "/audio" : undefined);
  const times = !o.audioBase ? NARRATION[o.lang][key] : undefined;
  const frame = vb
    ? html`<video class="video" controls preload="none" playsinline poster="${vb}/${o.lang}/${key}.jpg" aria-label="${name}">
        <source src="${vb}/${o.lang}/${key}.mp4" type="video/mp4"><track kind="captions" srclang="${o.lang}" label="${o.lang === "fr" ? "Français" : "English"}" src="/captions/${o.lang}/${key}.vtt" default></video>`
    : html`<div class="stage" data-stage>
        ${img(photo, o.lang, "stage-photo", false, Boolean(o.editing))}
        ${badge ?? ""}
        <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="big-play js-only" data-play-overlay aria-hidden="true">${svg(ICON.play)}</span>
        <p class="live-caption" data-caption aria-hidden="true">${lines[0] ?? ""}</p>
      </div>`;
  return html`<div class="player ${cls}" data-player data-lang="${HTML_LANG[o.lang]}"${!vb && ab ? html` data-audio="${ab}/${o.lang}/${key}.mp3"` : ""}${!vb && times ? html` data-times="${times.join(",")}"` : ""}${vb ? html` data-video` : ""}>
  <div class="frame">${frame}</div>
  ${vb ? "" : html`<div class="player-bar">
    <button type="button" class="btn play js-only" data-play data-label-play="${c.play}" data-label-pause="${c.pause}" data-label-replay="${c.replay}" aria-pressed="false">${svg(ICON.play)}<span>${c.play}</span></button>
    <span class="meta"><span class="duration">${COPY[o.lang].about(seconds(o.lang, lines))}</span>
    <span class="voice" data-voice aria-live="polite" data-device="${c.voiceDevice("{v}")}" data-recorded="${c.voiceRecorded}" data-none="${c.noVoice}"></span></span>
  </div>`}
  <div class="sr-only"><p>${c.transcript}</p><ol data-lines>${lines.map((l) => html`<li>${l}</li>`)}</ol></div>
</div>`;
}

function agentPanel(o: LandingOptions, a: AgentCopy, selected: boolean, i: number, all: AgentCopy[]): Html {
  const c = COPY[o.lang];
  const included = PLANS.filter((p) => isEntitled(p.id, [], a.id));
  const first = included[0]!;
  const prev = all[(i - 1 + all.length) % all.length]!; const next = all[(i + 1) % all.length]!;
  const badge = html`<span class="stage-badge">${svg(ICON[a.dept])}${c.agentBadge}</span>`;
  return html`<section class="panel dept-${a.dept}" role="tabpanel" id="agent-${a.id}" aria-labelledby="tab-${a.id}" tabindex="0"${selected ? "" : html` data-unselected`}>
  <div class="agent-card">
    <div class="agent-top">
      ${player(o, a.id, agentText(o, a, "name"), a.script[o.lang], photoFor(o, `photo.agent.${a.id}`, AGENT_PHOTO[a.id]!), "", badge)}
      <div class="agent-intro">
        <p class="agent-kicker">${svg(ICON[a.dept])}<span>${DEPTS[a.dept][o.lang]}</span></p>
        <h3>${T(o, `agent.${a.id}.name`, a.name[o.lang])}</h3>
        <p class="summary">${T(o, `agent.${a.id}.summary`, a.summary[o.lang])}</p>
        <div class="agent-plans">
          <p class="label">${c.plansIncluding}</p>
          <ul class="plan-chips">${PLANS.map((p) => included.includes(p) ? html`<li class="on">${svg(ICON.check)}${planName(o, p)}</li>` : "")}</ul>
        </div>
        <a class="btn primary start-link" href="/?lang=${o.lang}&amp;plan=${first.id}#start" data-choose="${first.id}" data-name="${planName(o, first)}">${c.startWith(planName(o, first))}${svg(ICON.arrow)}</a>
      </div>
    </div>
    <div class="how-wide">
      <h4>${c.howItWorks}</h4>
      <ol class="flow">${a.how[o.lang].map((s, k) => html`<li><span class="flow-n" aria-hidden="true">${k + 1}</span><div class="flow-body"><span class="flow-step" aria-hidden="true">${c.stepN(k + 1)}</span><p>${T(o, `agent.${a.id}.how.${k + 1}`, s)}</p></div></li>`)}</ol>
    </div>
    <footer class="agent-nav js-only">
      <button type="button" class="nav-btn" data-step="-1" aria-label="${c.prevAgent}: ${agentText(o, prev, "name")}">${svg(ICON.prev)}<span>${agentText(o, prev, "name")}</span></button>
      <span class="count">${c.ofAgents(i + 1, all.length)}</span>
      <button type="button" class="nav-btn next" data-step="1" aria-label="${c.nextAgent}: ${agentText(o, next, "name")}"><span>${agentText(o, next, "name")}</span>${svg(ICON.arrow)}</button>
    </footer>
  </div>
</section>`;
}

function planCard(o: LandingOptions, plan: Plan, selected: boolean): Html {
  const c = COPY[o.lang];
  const agents = billableAgents(plan.id).map((id) => agentName(o.lang, id));
  const planned = plan.agents.filter((id) => agentDef(id).status === "planned").map((id) => agentDef(id).name.replace(/^AI /, ""));
  const features = o.plans?.[plan.id]?.features[o.lang] ?? (o.lang === "fr" ? PLAN_FEATURES_FR[plan.id] ?? plan.features : plan.features);
  const priceCents = o.plans ? o.plans[plan.id]?.priceCents ?? null : plan.priceCents;
  const recommended = o.plans ? Boolean(o.plans[plan.id]?.recommended) : plan.id === "growth";
  const money = (cents: number) => { const v = cents / 100; const t = Number.isInteger(v) ? String(v) : v.toFixed(2); return o.lang === "fr" ? `${t.replace(".", ",")} $` : `$${t}`; };
  const name = planName(o, plan);
  return html`<article class="plan${selected ? " chosen" : ""}${recommended ? " recommended" : ""}" aria-labelledby="plan-${plan.id}" data-plan-card="${plan.id}" data-reveal>
  <h3 id="plan-${plan.id}">${name}</h3>
  <p class="price">${priceCents === null ? html`<span class="placeholder">${c.pricePlaceholder}</span>`
    : html`<strong>${money(priceCents)}</strong><span> ${c.perMonth}</span><span class="tax"> ${c.plusTax}</span>`}</p>
  <p class="count"><strong>${agents.length}</strong> ${c.agentsCount}</p>
  <ul class="ticks">${features.map((f) => html`<li>${svg(ICON.check)}<span>${f}</span></li>`)}</ul>
  <details><summary>${c.allAgents(agents.length)}</summary><ul class="small">${agents.map((a) => html`<li>${a}</li>`)}</ul>
    ${planned.length ? html`<p class="small muted">${c.comingNext(planned.join(", "))}</p>` : ""}</details>
  <a class="btn ${recommended ? "primary" : "secondary"}" href="/?lang=${o.lang}&amp;plan=${plan.id}#start" data-choose="${plan.id}" data-name="${name}">${c.startWith(name)}</a>
</article>`;
}

export function landingPage(o: LandingOptions): string {
  const c = COPY[o.lang];
  const v = o.values ?? {};
  const selected = o.plan && PLANS.some((p) => p.id === o.plan) ? o.plan : (v.plan ?? "growth");
  const open = Boolean(o.plan || o.error || Object.keys(v).length);
  const other: Lang = o.lang === "fr" ? "en" : "fr";
  const error = o.error && o.lang === "fr" ? o.error.split(" | ").map((m) => SIGNUP_ERRORS_FR[m] ?? m).join(" ") : o.error?.split(" | ").join(" ");
  const depts = Object.keys(DEPTS) as Dept[];
  const manager = AGENT_COPY.find((a) => a.id === "business-manager")!;
  const ordered = depts.flatMap((d) => AGENT_COPY.filter((a) => a.dept === d));
  const industry = (id: string, name: string) => (o.lang === "fr" ? INDUSTRY_FR[id] ?? name : name);
  const strip = html`${INDUSTRY_PACKS.map((p) => TRADE_PHOTO[p.id]
    ? html`<li class="trade">${img(photoFor(o, `photo.trade.${p.id}`, TRADE_PHOTO[p.id]!), o.lang, "", false, Boolean(o.editing))}<span>${industry(p.id, p.name)}</span></li>`
    : html`<li class="trade text"><span>${industry(p.id, p.name)}</span></li>`)}`;
  const layout = layoutOf(o.content?.["layout"]);
  const blocks: Record<SectionId, Html> = {
    team: html`<section id="team" class="section" data-section="team" aria-labelledby="team-title">
  <div class="wrap">
    <div class="section-head" data-reveal>
      <p class="eyebrow">${T(o, "team.eyebrow", c.teamEyebrow)}</p>
      <h2 id="team-title">${T(o, "team.title", c.teamTitle)}</h2>
      <p class="lead dark">${T(o, "team.lead", c.teamLead)}</p>
    </div>
    <div class="tabs" data-tabs data-reveal>
      <div class="dept-bar js-only" role="group" aria-label="${c.deptsLabel}"><div class="dept-track">
        ${depts.map((d) => html`<button type="button" class="dept-pill dept-${d}" data-dept="${d}" aria-pressed="${d === "front" ? "true" : "false"}">${svg(ICON[d])}<span>${DEPTS[d][o.lang]}</span><span class="n" aria-hidden="true">${AGENT_COPY.filter((a) => a.dept === d).length}</span></button>`)}
      </div></div>
      <div class="tablist" role="tablist" aria-label="${c.tabsLabel}" aria-orientation="horizontal">
        ${ordered.map((a, i) => html`<a role="tab" class="agent-chip dept-${a.dept}${i === 0 || ordered[i - 1]!.dept !== a.dept ? " first" : ""}" data-dept="${a.dept}" data-team="${DEPTS[a.dept][o.lang]}" id="tab-${a.id}" href="#agent-${a.id}" aria-controls="agent-${a.id}" aria-selected="${a.id === "customer-service" ? "true" : "false"}"><img src="${photoFor(o, `photo.agent.${a.id}`, AGENT_PHOTO[a.id]!).src ?? `/media/${AGENT_PHOTO[a.id]!.file}-thumb.jpg`}" width="44" height="44" alt="" loading="lazy" decoding="async"><span class="chip-name">${agentText(o, a, "name")}</span><span class="chip-go" aria-hidden="true"></span></a>`)}
      </div>
      <div class="panels">${ordered.map((a, i) => agentPanel(o, a, a.id === "customer-service", i, ordered))}</div>
    </div>
  </div>
</section>`,
    day: html`<section id="day" class="section day" data-section="day" aria-labelledby="day-title">
  <div class="wrap">
    <div class="section-head" data-reveal>
      <p class="eyebrow">${T(o, "day.eyebrow", c.dayEyebrow)}</p>
      <h2 id="day-title">${T(o, "day.title", c.dayTitle)}</h2>
      <p class="lead dark">${T(o, "day.lead", c.dayLead)}</p>
    </div>
    <ol class="timeline" data-timeline>
      <li class="progress" aria-hidden="true"><span data-progress></span></li>
      ${c.day.map(([time, title, text, who, level], i) => html`<li class="moment${i % 2 ? " flip" : ""}" data-reveal>
        <figure class="moment-photo" data-parallax>${img(photoFor(o, `photo.day.${i + 1}`, DAY_PHOTOS[i]!), o.lang, "", false, Boolean(o.editing))}</figure>
        <div class="moment-text">
          <p class="time"><time>${T(o, `day.${i + 1}.time`, time)}</time></p>
          <h3>${T(o, `day.${i + 1}.title`, title)}</h3>
          <p>${T(o, `day.${i + 1}.text`, text)}</p>
          <p class="who"><span class="by">${who}</span><span class="level ${level}">${svg(ICON[level])}${c.levels[level]}</span></p>
        </div>
      </li>`)}
    </ol>
    <div class="ok-note" data-reveal>${svg(ICON.ok)}<div><p><b>${c.levels.ok}.</b> ${T(o, "day.ok", c.okNote)}</p><p class="small">${T(o, "day.pilot", c.pilotNote)}</p></div></div>
  </div>
</section>`,
    plans: html`<section id="plans" class="section band-soft" data-section="plans" aria-labelledby="plans-title">
  <div class="wrap">
    <div class="section-head" data-reveal>
      <p class="eyebrow">${T(o, "plans.eyebrow", c.plansEyebrow)}</p>
      <h2 id="plans-title">${T(o, "plans.title", c.plansTitle)}</h2>
    </div>
    <div class="plans">${PLANS.map((p) => planCard(o, p, open && p.id === selected))}</div>
    <p class="fine center">${T(o, "plans.fine", c.plansFine)}</p>

    <div id="start" class="start${open ? " open" : ""}" data-start role="region" aria-labelledby="start-title">
      <div class="start-inner">
        <div class="start-copy">
          <h2 id="start-title">${T(o, "start.title", c.startTitle)}</h2>
          <ul class="ticks">${c.startTicks.map((t, k) => html`<li>${svg(ICON.check)}<span>${T(o, `start.tick.${k + 1}`, t)}</span></li>`)}</ul>
        </div>
        ${o.signupOpen ? html`<form class="signup" method="post" action="/signup?lang=${o.lang}#start" novalidate>
          ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
          <input type="hidden" name="lang" value="${o.lang}">
          <fieldset class="plan-pick"><legend>${c.form.plan}</legend>${PLANS.map((p) => html`<label class="pick"><input type="radio" name="plan" value="${p.id}"${p.id === selected ? html` checked` : ""}><span>${planName(o, p)}</span></label>`)}</fieldset>
          <label>${c.form.business}<input name="business" required maxlength="120" autocomplete="organization" value="${v.business ?? ""}"></label>
          <label>${c.form.industry}<select name="industry" required>${INDUSTRY_PACKS.map((p) => html`<option value="${p.id}"${v.industry === p.id ? html` selected` : ""}>${industry(p.id, p.name)}</option>`)}</select></label>
          <label>${c.form.name}<input name="name" required maxlength="120" autocomplete="name" value="${v.name ?? ""}"></label>
          <label>${c.form.email}<input name="email" type="email" required autocomplete="email" value="${v.email ?? ""}"></label>
          <label>${c.form.password} <span class="hint">${c.form.passwordHint}</span><input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
          <label class="hp" aria-hidden="true">${c.form.website}<input name="website" tabindex="-1" autocomplete="off"></label>
          <label class="check"><input type="checkbox" name="pilot" value="yes" required${v.pilot === "yes" ? html` checked` : ""}><span>${c.form.pilot}</span></label>
          <label class="check"><input type="checkbox" name="marketing" value="yes"${v.marketing === "yes" ? html` checked` : ""}><span>${o.lang === "fr" ? MARKETING_CONSENT_WORDING_FR : MARKETING_CONSENT_WORDING} <span class="hint">${c.form.optional}</span></span></label>
          <button class="btn primary wide" type="submit">${c.form.submit}</button>
        </form>` : html`<div class="signup closed"><h3>${c.closedTitle}</h3><p>${c.closedText} <a href="/login">${c.closedLink}</a>.</p></div>`}
      </div>
    </div>
  </div>
</section>`,
    faq: html`<section id="faq" class="section" data-section="faq" aria-labelledby="faq-title">
  <div class="wrap narrow" data-reveal>
    <h2 id="faq-title">${T(o, "faq.title", c.faqTitle)}</h2>
    ${c.faq.map(([q, a], k) => html`<details class="faq"${o.editing ? html` open` : ""}><summary>${T(o, `faq.${k + 1}.q`, q)}</summary><p>${T(o, `faq.${k + 1}.a`, a)}</p></details>`)}
  </div>
</section>`,
  };
  // In the editor hidden sections stay visible (marked), so they can be shown again.
  const sections = layout.order.filter((id) => o.editing || !layout.hidden.includes(id)).map((id) => o.editing && layout.hidden.includes(id) ? html`<div class="ed-hidden-section">${blocks[id]}</div>` : blocks[id]);
  return html`<!doctype html>
<html lang="${HTML_LANG[o.lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.title}</title><meta name="description" content="${c.description}">
<link rel="alternate" hreflang="en-CA" href="/?lang=en"><link rel="alternate" hreflang="fr-CA" href="/?lang=fr">
<meta name="theme-color" content="#172D46"><link rel="stylesheet" href="/static/landing.css"><link rel="preload" href="/static/manrope.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" as="image" href="/media/${HERO_VIDEO.poster}">
<script src="/static/landing.js" defer></script>
${o.editing ? html`<link rel="stylesheet" href="/admin/static/editor.css"><script src="/admin/static/editor.js" defer></script>` : ""}
</head><body${o.editing ? html` class="editing"` : ""}>
${o.editing ? html`<div id="ed-bar" data-csrf="${o.editing.csrf}" data-lang="${o.lang}" data-pending="${o.editing.pending}" data-can-publish="${o.editing.canPublish ? "1" : ""}"></div>` : ""}
<a class="skip" href="#main">${c.skip}</a>
${o.lang === "fr" && !o.frReviewedBy ? html`<p class="review-note" role="note">${c.reviewNote}</p>` : ""}
<header class="site" data-header>
  <div class="wrap bar">
    <a class="logo" href="/?lang=${o.lang}"><span class="mark" aria-hidden="true">C</span><span>CONARO <b>Business AI</b></span></a>
    <nav aria-label="${o.lang === "fr" ? "Principal" : "Main"}" class="links"><a href="#team">${c.nav.agents}</a><a href="#day">${c.nav.how}</a><a href="#plans">${c.nav.plans}</a><a href="#faq">${c.nav.faq}</a></nav>
    <div class="actions"><a class="lang" href="/?lang=${other}" hreflang="${HTML_LANG[other]}" lang="${HTML_LANG[other]}" aria-label="${c.switchLabel}">${svg(ICON.globe)}<span>${c.switchTo}</span></a><a class="quiet" href="/login">${c.nav.signIn}</a><a class="btn primary small" href="#plans">${c.nav.cta}</a></div>
    <details class="menu"><summary>${c.nav.menu}</summary><nav aria-label="${c.nav.menu}"><a href="#team">${c.nav.agents}</a><a href="#day">${c.nav.how}</a><a href="#plans">${c.nav.plans}</a><a href="#faq">${c.nav.faq}</a><a href="/login">${c.nav.signIn}</a></nav></details>
  </div>
</header>
<main id="main">
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-media" aria-hidden="true">
    <video class="hero-video" data-hero-video muted loop playsinline preload="metadata" poster="/media/${HERO_VIDEO.poster}">
      <source src="/media/${HERO_VIDEO.webm}" type="video/webm"><source src="/media/${HERO_VIDEO.mp4}" type="video/mp4">
    </video>
  </div>
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">${T(o, "hero.eyebrow", c.eyebrow)}</p>
      <h1 id="hero-title"><span class="line">${T(o, "hero.title1", `${c.h1.split(". ")[0]}.`)}</span> <span class="line accent">${T(o, "hero.title2", c.h1.split(". ").slice(1).join(". "))}</span></h1>
      <p class="lead">${T(o, "hero.lead", c.lead(AGENT_COPY.length))}</p>
      <div class="cta-row"><a class="btn primary" href="#plans">${T(o, "hero.cta", c.ctaPlans)}${svg(ICON.arrow)}</a><a class="btn ghost" href="#team">${T(o, "hero.cta2", c.ctaMeet)}</a></div>
    </div>
    <div class="hero-card">
      <p class="card-label">${T(o, "hero.listen", c.heroListen)}</p>
      ${player(o, "business-manager", agentText(o, manager, "name"), manager.script[o.lang], photoFor(o, "photo.agent.business-manager", AGENT_PHOTO["business-manager"]!), "compact")}
    </div>
  </div>
  <button type="button" class="video-toggle js-only" data-video-toggle data-label-pause="${c.videoPause}" data-label-play="${c.videoPlay}" aria-label="${c.videoPause}">${svg(ICON.pause)}</button>
  <div class="marquee" aria-label="${c.tradesLabel}" role="region"><ul class="marquee-track">${strip}</ul><ul class="marquee-track" aria-hidden="true">${strip}</ul></div>
</section>

${sections}
</main>
<footer class="site-footer">
  <div class="wrap foot">
    <p><b>CONARO Business AI</b> · ${T(o, "footer.place", c.footer)}</p>
    <p class="small">${c.partOf} <a href="https://www.conaro.ca">CONARO</a> · <a href="/login">${c.nav.signIn}</a> · <a href="/?lang=${other}" lang="${HTML_LANG[other]}">${c.switchTo}</a> · <span class="placeholder-text">${c.legal}</span></p>
    <details class="credits"><summary>${c.credits}</summary><p class="small">${c.photoNote}</p>
      <ul class="small">${CREDITS.map((k) => html`<li><a href="${k.source}">${k.title}</a> · ${k.author} · ${k.license}${k.changes ? html` · ${k.changes[o.lang]}` : ""}</li>`)}</ul></details>
  </div>
</footer>
</body></html>`.value;
}

export { raw };
