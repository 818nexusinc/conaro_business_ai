import { html, raw, type Html } from "../shared/html.ts";
import { PLANS, billableAgents, isEntitled, type Plan } from "../catalog/plans.ts";
import { INDUSTRY_PACKS } from "../catalog/industries.ts";
import { agentDef } from "../catalog/agents.ts";
import { HTML_LANG, type Lang } from "../i18n.ts";
import { AGENT_COPY, CONTROL_SCRIPT, DEPTS, type AgentCopy, type Dept } from "./agents-copy.ts";
import { COPY, INDUSTRY_FR, PLAN_FEATURES_FR, PLAN_NAME_FR, SIGNUP_ERRORS_FR } from "./copy.ts";
import { MARKETING_CONSENT_WORDING, MARKETING_CONSENT_WORDING_FR } from "./signup.ts";

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
}

const TONES: Record<Dept, string> = { manage: "navy", front: "copper", jobs: "teal", money: "olive", growth: "plum", office: "slate" };
const svg = (path: string) => html`<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const ICON = {
  check: "M5 12.5l4.5 4.5L19 7.5", shield: "M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6l7-3z", pause: "M8 5v14M16 5v14",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5", pin: "M12 21s-6-5.6-6-11a6 6 0 1112 0c0 5.4-6 11-6 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  play: "M8 5l11 7-11 7z", globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
};
const planName = (lang: Lang, p: Plan) => (lang === "fr" ? PLAN_NAME_FR[p.id] ?? p.name : p.name);
const agentName = (lang: Lang, id: string) => AGENT_COPY.find((a) => a.id === id)?.name[lang] ?? agentDef(id).name.replace(/^AI /, "");

/**
 * A presenter: a recorded video when one exists, otherwise an illustrated presenter that speaks the script
 * (recorded narration if present, else the device's most natural voice, chosen by /static/landing.js) with
 * captions. Without JavaScript the full script is shown.
 */
function player(o: LandingOptions, key: string, name: string, tone: string, lines: string[], heading?: Html): Html {
  const c = COPY[o.lang].player;
  const vb = o.videoBase?.replace(/\/$/, "");
  const ab = o.audioBase?.replace(/\/$/, "");
  const frame = vb
    ? html`<video class="video" controls preload="none" playsinline poster="${vb}/${o.lang}/${key}.jpg" aria-label="${name}">
        <source src="${vb}/${o.lang}/${key}.mp4" type="video/mp4"><track kind="captions" srclang="${o.lang}" label="${o.lang === "fr" ? "Français" : "English"}" src="/captions/${o.lang}/${key}.vtt" default></video>`
    : html`<div class="stage tone-${tone}" data-stage>
        <svg class="avatar" viewBox="0 0 120 120" role="img" aria-label="${c.presenter(name)}" focusable="false">
          <circle cx="60" cy="44" r="22" class="head"/><path d="M18 116c4-28 22-42 42-42s38 14 42 42z" class="body"/>
          <rect x="50" y="52" width="20" height="4" rx="2" class="mouth"/><circle cx="52" cy="41" r="2.5" class="eye"/><circle cx="68" cy="41" r="2.5" class="eye"/>
        </svg>
        <p class="live-caption" data-caption aria-hidden="true">${lines[0] ?? ""}</p>
      </div>`;
  return html`<div class="player" data-player data-lang="${HTML_LANG[o.lang]}"${!vb && ab ? html` data-audio="${ab}/${o.lang}/${key}.mp3"` : ""}${vb ? html` data-video` : ""}>
  <div class="frame">${frame}</div>
  ${vb ? "" : html`<div class="player-bar">
    <button type="button" class="btn play js-only" data-play data-label-play="${c.play}" data-label-pause="${c.pause}" data-label-replay="${c.replay}" aria-pressed="false">${svg(ICON.play)}<span>${c.play}</span></button>
    <span class="voice" data-voice aria-live="polite" data-device="${c.voiceDevice("{v}")}" data-recorded="${c.voiceRecorded}" data-none="${c.noVoice}"></span>
  </div>`}
  ${heading ?? ""}
  <details class="transcript"><summary>${c.transcript}</summary><ol data-lines>${lines.map((l) => html`<li>${l}</li>`)}</ol></details>
</div>`;
}

function agentPanel(o: LandingOptions, a: AgentCopy, selected: boolean): Html {
  const c = COPY[o.lang];
  const plans = PLANS.filter((p) => isEntitled(p.id, [], a.id)).map((p) => planName(o.lang, p));
  return html`<section class="panel" role="tabpanel" id="agent-${a.id}" aria-labelledby="tab-${a.id}" tabindex="0"${selected ? "" : html` data-unselected`}>
  <div class="panel-grid">
    ${player(o, a.id, a.name[o.lang], TONES[a.dept], a.script[o.lang])}
    <div class="panel-text">
      <p class="eyebrow">${DEPTS[a.dept][o.lang]}</p>
      <h3>${a.name[o.lang]}</h3>
      <p class="summary">${a.summary[o.lang]}</p>
      <h4>${c.howItWorks}</h4>
      <ol class="how">${a.how[o.lang].map((s) => html`<li>${s}</li>`)}</ol>
      <p class="included"><b>${c.plansIncluding}</b> ${plans.length === PLANS.length ? c.allPlans : plans.join(" · ")}</p>
    </div>
  </div>
</section>`;
}

function planCard(o: LandingOptions, plan: Plan): Html {
  const c = COPY[o.lang];
  const agents = billableAgents(plan.id).map((id) => agentName(o.lang, id));
  const planned = plan.agents.filter((id) => agentDef(id).status === "planned").map((id) => agentDef(id).name.replace(/^AI /, ""));
  const features = o.lang === "fr" ? PLAN_FEATURES_FR[plan.id] ?? plan.features : plan.features;
  const name = planName(o.lang, plan);
  return html`<article class="plan" aria-labelledby="plan-${plan.id}">
  <h3 id="plan-${plan.id}">${name}</h3>
  <p class="price">${plan.priceCents === null ? html`<span class="placeholder">${c.pricePlaceholder}</span>`
    : o.lang === "fr" ? html`<strong>${(plan.priceCents / 100).toFixed(0)} $</strong><span> ${c.perMonth}</span>` : html`<strong>$${(plan.priceCents / 100).toFixed(0)}</strong><span> ${c.perMonth}</span>`}</p>
  <p class="count"><strong>${agents.length}</strong> ${c.agentsCount}</p>
  <ul class="ticks">${features.map((f) => html`<li>${svg(ICON.check)}<span>${f}</span></li>`)}</ul>
  <details><summary>${c.allAgents(agents.length)}</summary><ul class="small">${agents.map((a) => html`<li>${a}</li>`)}</ul>
    ${planned.length ? html`<p class="small muted">${c.comingNext(planned.join(", "))}</p>` : ""}</details>
  <a class="btn ${plan.id === "growth" ? "primary" : "secondary"}" href="/?lang=${o.lang}&amp;plan=${plan.id}#start">${c.startWith(name)}</a>
</article>`;
}

export function landingPage(o: LandingOptions): string {
  const c = COPY[o.lang];
  const v = o.values ?? {};
  const selected = o.plan && PLANS.some((p) => p.id === o.plan) ? o.plan : (v.plan ?? "growth");
  const other: Lang = o.lang === "fr" ? "en" : "fr";
  const error = o.error && o.lang === "fr" ? o.error.split(" | ").map((m) => SIGNUP_ERRORS_FR[m] ?? m).join(" ") : o.error?.split(" | ").join(" ");
  const depts = Object.keys(DEPTS) as Dept[];
  const manager = AGENT_COPY.find((a) => a.id === "business-manager")!;
  const industry = (id: string, name: string) => (o.lang === "fr" ? INDUSTRY_FR[id] ?? name : name);
  return html`<!doctype html>
<html lang="${HTML_LANG[o.lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.title}</title><meta name="description" content="${c.description}">
<link rel="alternate" hreflang="en-CA" href="/?lang=en"><link rel="alternate" hreflang="fr-CA" href="/?lang=fr">
<meta name="theme-color" content="#172D46"><link rel="stylesheet" href="/static/landing.css"><link rel="preload" href="/static/manrope.woff2" as="font" type="font/woff2" crossorigin>
<script src="/static/landing.js" defer></script>
</head><body>
<a class="skip" href="#main">${c.skip}</a>
<header class="site">
  <div class="wrap bar">
    <a class="logo" href="/?lang=${o.lang}"><span class="mark" aria-hidden="true">C</span><span>CONARO <b>Business AI</b></span></a>
    <nav aria-label="${o.lang === "fr" ? "Principal" : "Main"}" class="links"><a href="#team">${c.nav.agents}</a><a href="#how">${c.nav.how}</a><a href="#plans">${c.nav.plans}</a><a href="#faq">${c.nav.faq}</a></nav>
    <div class="actions"><a class="lang" href="/?lang=${other}" hreflang="${HTML_LANG[other]}" lang="${HTML_LANG[other]}" aria-label="${c.switchLabel}">${svg(ICON.globe)}<span>${c.switchTo}</span></a><a class="quiet" href="/login">${c.nav.signIn}</a><a class="btn primary small" href="#plans">${c.nav.cta}</a></div>
    <details class="menu"><summary>${c.nav.menu}</summary><nav aria-label="${c.nav.menu}"><a href="#team">${c.nav.agents}</a><a href="#how">${c.nav.how}</a><a href="#plans">${c.nav.plans}</a><a href="#faq">${c.nav.faq}</a><a href="/login">${c.nav.signIn}</a></nav></details>
  </div>
</header>
${o.lang === "fr" && !o.frReviewedBy ? html`<p class="review-note" role="note">${c.reviewNote}</p>` : ""}
<main id="main">
<section class="hero band-navy" aria-labelledby="hero-title">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">${c.eyebrow}</p>
      <h1 id="hero-title">${c.h1}</h1>
      <p class="lead">${c.lead(AGENT_COPY.length)}</p>
      <div class="cta-row"><a class="btn primary" href="#plans">${c.ctaPlans}</a><a class="btn ghost" href="#team">${svg(ICON.play)}<span>${c.ctaMeet}</span></a></div>
      <p class="fine">${c.fine}</p>
    </div>
    <div class="hero-player">${player(o, "business-manager", manager.name[o.lang], "navy", manager.script[o.lang])}</div>
  </div>
</section>

<section class="facts" aria-label="${c.factsLabel}">
  <ul class="wrap fact-list">${c.facts.map((f, i) => html`<li>${svg([ICON.pin, ICON.shield, ICON.pause][i]!)}<span>${f}</span></li>`)}</ul>
</section>

<section id="team" class="section" aria-labelledby="team-title">
  <div class="wrap">
    <p class="eyebrow">${c.teamEyebrow}</p>
    <h2 id="team-title">${c.teamTitle}</h2>
    <p class="lead dark">${c.teamLead}</p>
    <div class="tabs" data-tabs>
      <div class="tablist" role="tablist" aria-label="${c.tabsLabel}" aria-orientation="vertical">
        ${depts.map((d) => html`<p class="tab-group" aria-hidden="true">${DEPTS[d][o.lang]}</p>${AGENT_COPY.filter((a) => a.dept === d).map((a) => html`<a role="tab" id="tab-${a.id}" href="#agent-${a.id}" aria-controls="agent-${a.id}" aria-selected="${a.id === "customer-service" ? "true" : "false"}">${a.name[o.lang]}</a>`)}`)}
      </div>
      <div class="panels">${depts.flatMap((d) => AGENT_COPY.filter((a) => a.dept === d)).map((a) => agentPanel(o, a, a.id === "customer-service"))}</div>
    </div>
  </div>
</section>

<section id="how" class="section band-soft" aria-labelledby="how-title">
  <div class="wrap">
    <p class="eyebrow">${c.stepsEyebrow}</p>
    <h2 id="how-title">${c.stepsTitle}</h2>
    <ol class="steps">${c.steps.map(([t, d, who], i) => html`<li><span class="num" aria-hidden="true">${i + 1}</span><h3>${t}</h3><p>${d}</p><p class="who">${who}</p></li>`)}</ol>
  </div>
</section>

<section id="control" class="section" aria-labelledby="control-title">
  <div class="wrap control-grid">
    ${player(o, "control", c.controlName, "sand", CONTROL_SCRIPT[o.lang])}
    <div>
      <p class="eyebrow">${c.controlEyebrow}</p>
      <h2 id="control-title">${c.controlTitle}</h2>
      <ol class="levels">${c.levels.map(([b, s]) => html`<li><b>${b}</b><span>${s}</span></li>`)}</ol>
      <p class="note">${svg(ICON.doc)}<span>${c.pilotNote}</span></p>
    </div>
  </div>
</section>

<section class="section band-soft" aria-labelledby="trades-title">
  <div class="wrap">
    <p class="eyebrow">${c.tradesEyebrow}</p>
    <h2 id="trades-title">${c.tradesTitle}</h2>
    <p class="lead dark">${c.tradesLead}</p>
    <ul class="chips big">${INDUSTRY_PACKS.map((p) => html`<li>${industry(p.id, p.name)}</li>`)}</ul>
  </div>
</section>

<section id="plans" class="section" aria-labelledby="plans-title">
  <div class="wrap">
    <p class="eyebrow">${c.plansEyebrow}</p>
    <h2 id="plans-title">${c.plansTitle}</h2>
    <div class="plans">${PLANS.map((p) => planCard(o, p))}</div>
    <p class="fine center">${c.plansFine}</p>
  </div>
</section>

<section id="start" class="section band-navy" aria-labelledby="start-title">
  <div class="wrap start-grid">
    <div>
      <p class="eyebrow">${c.startEyebrow}</p>
      <h2 id="start-title">${c.startTitle}</h2>
      <ul class="ticks light">${c.startTicks.map((t) => html`<li>${svg(ICON.check)}<span>${t}</span></li>`)}</ul>
    </div>
    ${o.signupOpen ? html`<form class="signup" method="post" action="/signup?lang=${o.lang}#start" novalidate>
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
      <input type="hidden" name="lang" value="${o.lang}">
      <fieldset class="plan-pick"><legend>${c.form.plan}</legend>${PLANS.map((p) => html`<label class="pick"><input type="radio" name="plan" value="${p.id}"${p.id === selected ? html` checked` : ""}><span>${planName(o.lang, p)}</span></label>`)}</fieldset>
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
</section>

<section id="faq" class="section" aria-labelledby="faq-title">
  <div class="wrap narrow">
    <h2 id="faq-title">${c.faqTitle}</h2>
    ${c.faq.map(([q, a]) => html`<details class="faq"><summary>${q}</summary><p>${a}</p></details>`)}
  </div>
</section>
</main>
<footer class="site-footer band-navy">
  <div class="wrap foot">
    <p><b>CONARO Business AI</b> · ${c.footer}</p>
    <p class="small">${c.partOf} <a href="https://www.conaro.ca">CONARO</a> · <a href="/login">${c.nav.signIn}</a> · <a href="/?lang=${other}" lang="${HTML_LANG[other]}">${c.switchTo}</a> · <span class="placeholder-text">${c.legal}</span></p>
  </div>
</footer>
</body></html>`.value;
}

export { raw };
