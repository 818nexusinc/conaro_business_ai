import { html, type Html } from "../shared/html.ts";
import { PLANS, billableAgents, type Plan } from "../catalog/plans.ts";
import { INDUSTRY_PACKS } from "../catalog/industries.ts";
import { agentDef, AGENTS } from "../catalog/agents.ts";
import { PRESENTERS, agentNames, type Presenter } from "./presenters.ts";
import { MARKETING_CONSENT_WORDING } from "./signup.ts";

export interface LandingOptions {
  /** Base URL of the presenter videos (<id>.mp4 and poster <id>.jpg). Without it, illustrated presenter cards are shown. */
  videoBase?: string | undefined;
  signupOpen: boolean;
  /** Pre-selected plan (from ?plan=). */
  plan?: string | undefined;
  /** Sign-up form error and the values to keep. */
  error?: string | undefined;
  values?: Record<string, string> | undefined;
}

const presenterById = (id: string) => PRESENTERS.find((p) => p.id === id)!;
const svg = (path: string, label?: string) => html`<svg class="icon" viewBox="0 0 24 24" width="24" height="24" ${label ? html`role="img" aria-label="${label}"` : html`aria-hidden="true"`} focusable="false"><path d="${path}"/></svg>`;
const ICON = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  shield: "M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6l7-3z",
  pause: "M8 5v14M16 5v14",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  pin: "M12 21s-6-5.6-6-11a6 6 0 1112 0c0 5.4-6 11-6 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  play: "M8 5l11 7-11 7z",
};

/** The illustrated stand-in shown until a presenter's video file exists: an abstract figure, never a real person. */
function presenterCard(p: Presenter): Html {
  return html`<div class="stage tone-${p.tone}">
  <svg class="avatar" viewBox="0 0 120 120" role="img" aria-label="Illustrated AI presenter for ${p.presenter}" focusable="false">
    <circle cx="60" cy="44" r="22" class="head"/>
    <path d="M18 116c4-28 22-42 42-42s38 14 42 42z" class="body"/>
    <rect x="50" y="52" width="20" height="4" rx="2" class="mouth"/>
    <circle cx="52" cy="41" r="2.5" class="eye"/><circle cx="68" cy="41" r="2.5" class="eye"/>
  </svg>
  <div class="reel n${p.script.length}" aria-hidden="true">${p.script.map((line, i) => html`<p class="l${i + 1}">${line}</p>`)}</div>
  <span class="soon">Presenter video coming soon · captions playing</span>
</div>`;
}

function presenter(p: Presenter, opts: LandingOptions, headingLevel: 2 | 3 = 3): Html {
  const base = opts.videoBase?.replace(/\/$/, "");
  const media = base
    ? html`<video class="video" controls preload="none" playsinline poster="${base}/${p.id}.jpg" aria-label="${p.title}: video presenter">
        <source src="${base}/${p.id}.mp4" type="video/mp4"><track kind="captions" srclang="en" label="English" src="/captions/${p.id}.vtt" default>
        <a href="${base}/${p.id}.mp4">Download the video</a></video>`
    : presenterCard(p);
  const names = agentNames(p);
  return html`<figure class="presenter" id="video-${p.id}">
  <div class="frame">${media}</div>
  <figcaption>
    ${headingLevel === 2 ? html`<h2>${p.title}</h2>` : html`<h3>${p.title}</h3>`}
    <p>${p.tagline}</p>
    ${names.length ? html`<ul class="chips" aria-label="Agents">${names.map((n) => html`<li>${n}</li>`)}</ul>` : ""}
    <details class="script"><summary>Read the script</summary>${p.script.map((l) => html`<p>${l}</p>`)}</details>
  </figcaption>
</figure>`;
}

function planCard(plan: Plan): Html {
  const agents = billableAgents(plan.id).map((id) => agentDef(id).name.replace(/^AI /, ""));
  const planned = plan.agents.filter((id) => agentDef(id).status === "planned").map((id) => agentDef(id).name.replace(/^AI /, ""));
  return html`<article class="plan" aria-labelledby="plan-${plan.id}">
  <h3 id="plan-${plan.id}">${plan.name}</h3>
  <p class="price">${plan.priceCents === null
    ? html`<span class="placeholder">Price announced before billing starts</span>`
    : html`<strong>$${(plan.priceCents / 100).toFixed(0)}</strong><span> / month</span>`}</p>
  <p class="count"><strong>${agents.length}</strong> AI agents</p>
  <ul class="ticks">${plan.features.map((f) => html`<li>${svg(ICON.check)}<span>${f}</span></li>`)}</ul>
  <details><summary>All ${agents.length} agents</summary><ul class="small">${agents.map((a) => html`<li>${a}</li>`)}</ul>
    ${planned.length ? html`<p class="small muted">Coming next, included when ready: ${planned.join(", ")}.</p>` : ""}</details>
  <a class="btn ${plan.id === "growth" ? "primary" : "secondary"}" href="/?plan=${plan.id}#start">Start with ${plan.name}</a>
</article>`;
}

export function landingPage(opts: LandingOptions): string {
  const v = opts.values ?? {};
  const selected = opts.plan && PLANS.some((p) => p.id === opts.plan) ? opts.plan : (v.plan ?? "growth");
  const operational = AGENTS.filter((a) => a.status === "operational").length;
  const steps: [string, string, string][] = [
    ["Enquiry arrives", "From your website, phone, social or CONARO.", "Customer Service"],
    ["Qualified", "Right service, area and season, scored with reasons.", "Sales"],
    ["Quoted", "Your prices, fees and the correct GST/HST.", "Quotation"],
    ["Booked", "Checked against hours, skills and travel; staff assigned.", "Booking · Workforce"],
    ["Invoiced", "From the accepted quote; payments matched, reminders prepared.", "Invoicing"],
  ];
  return html`<!doctype html>
<html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CONARO Business AI · An AI workforce for local service businesses</title>
<meta name="description" content="AI agents that answer enquiries, quote, book, invoice and keep the books for service businesses in Greater Moncton. You set the rules; big decisions wait for you.">
<meta name="theme-color" content="#172D46"><link rel="stylesheet" href="/static/landing.css"><link rel="preload" href="/static/manrope.woff2" as="font" type="font/woff2" crossorigin>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
  <div class="wrap bar">
    <a class="logo" href="/"><span class="mark" aria-hidden="true">C</span><span>CONARO <b>Business AI</b></span></a>
    <nav aria-label="Main" class="links"><a href="#workforce">Agents</a><a href="#how">How it works</a><a href="#plans">Plans</a><a href="#faq">Questions</a></nav>
    <div class="actions"><a class="quiet" href="/login">Sign in</a><a class="btn primary small" href="#plans">Choose your plan</a></div>
    <details class="menu"><summary aria-label="Menu">Menu</summary><nav aria-label="Main, mobile"><a href="#workforce">Agents</a><a href="#how">How it works</a><a href="#plans">Plans</a><a href="#faq">Questions</a><a href="/login">Sign in</a></nav></details>
  </div>
</header>
<main id="main">
<section class="hero band-navy" aria-labelledby="hero-title">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">For local service businesses · Greater Moncton</p>
      <h1 id="hero-title">Your business. Your AI workforce.</h1>
      <p class="lead">${operational} AI agents answer enquiries, quote, book, invoice and keep your books, while you do the work you're good at.</p>
      <div class="cta-row"><a class="btn primary" href="#plans">Choose your plan</a><a class="btn ghost" href="#video-manager">${svg(ICON.play)}<span>Meet your AI manager</span></a></div>
      <p class="fine">No card needed. You set the rules; big decisions wait for you.</p>
    </div>
    ${presenter(presenterById("manager"), opts, 2)}
  </div>
</section>

<section class="facts" aria-label="Why it is safe to start">
  <ul class="wrap fact-list">
    <li>${svg(ICON.pin)}<span>Made for Greater Moncton service businesses</span></li>
    <li>${svg(ICON.shield)}<span>Your own private workspace, walled off from every other business</span></li>
    <li>${svg(ICON.pause)}<span>Nothing sent or spent outside your rules, and one button pauses it all</span></li>
  </ul>
</section>

<section id="workforce" class="section" aria-labelledby="workforce-title">
  <div class="wrap">
    <p class="eyebrow">Meet your workforce</p>
    <h2 id="workforce-title">A whole team, working on your business every day</h2>
    <div class="presenters">
      ${["front-desk", "scheduling", "money", "growth", "office"].map((id) => presenter(presenterById(id), opts))}
    </div>
  </div>
</section>

<section id="how" class="section band-soft" aria-labelledby="how-title">
  <div class="wrap">
    <p class="eyebrow">How it works</p>
    <h2 id="how-title">From enquiry to paid job, handled</h2>
    <ol class="steps">${steps.map(([t, d, who], i) => html`<li><span class="num" aria-hidden="true">${i + 1}</span><h3>${t}</h3><p>${d}</p><p class="who">${who}</p></li>`)}</ol>
  </div>
</section>

<section id="control" class="section" aria-labelledby="control-title">
  <div class="wrap control-grid">
    ${presenter(presenterById("control"), opts)}
    <div>
      <p class="eyebrow">You stay in control</p>
      <h2 id="control-title">As hands-off as you want, never out of your hands</h2>
      <ol class="levels">
        <li><b>Automatic</b><span>Reports, drafts, scoring and reminders.</span></li>
        <li><b>Your rules</b><span>Quotes, bookings and follow-ups go out only within limits you switch on.</span></li>
        <li><b>Your OK</b><span>Prices, refunds, ad spend and anything legal always wait for you.</span></li>
      </ol>
      <p class="note">${svg(ICON.doc)}<span>Pilot: the agents prepare everything in a safe simulation until you connect your email, calendar and accounts. You see exactly what would have been sent.</span></p>
    </div>
  </div>
</section>

<section class="section band-soft" aria-labelledby="trades-title">
  <div class="wrap">
    <p class="eyebrow">Made for your trade</p>
    <h2 id="trades-title">It already knows how your industry works</h2>
    <p class="lead dark">Seasons, emergency calls, crews and equipment, recurring visits: each trade gets its own rules and checklists.</p>
    <ul class="chips big">${INDUSTRY_PACKS.map((p) => html`<li>${p.name}</li>`)}</ul>
  </div>
</section>

<section id="plans" class="section" aria-labelledby="plans-title">
  <div class="wrap">
    <p class="eyebrow">Plans</p>
    <h2 id="plans-title">Start with the team you need, grow into the rest</h2>
    <div class="plans">${PLANS.map(planCard)}</div>
    <p class="fine center">Billing isn't switched on yet: you'll see and agree to a price before you're ever charged. Advertising, payment processing and other services are separate from your plan.</p>
  </div>
</section>

<section id="start" class="section band-navy" aria-labelledby="start-title">
  <div class="wrap start-grid">
    <div>
      <p class="eyebrow">Start your pilot</p>
      <h2 id="start-title">Your workspace is ready in a minute</h2>
      <ul class="ticks light">
        <li>${svg(ICON.check)}<span>No card needed</span></li>
        <li>${svg(ICON.check)}<span>Change plans or pause at any time</span></li>
        <li>${svg(ICON.check)}<span>Your Business Manager walks you through set-up</span></li>
      </ul>
    </div>
    ${opts.signupOpen ? html`<form class="signup" method="post" action="/signup#start" novalidate>
      ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ""}
      <fieldset class="plan-pick"><legend>Plan</legend>${PLANS.map((p) => html`<label class="pick"><input type="radio" name="plan" value="${p.id}"${p.id === selected ? html` checked` : ""}><span>${p.name}</span></label>`)}</fieldset>
      <label>Business name<input name="business" required maxlength="120" autocomplete="organization" value="${v.business ?? ""}"></label>
      <label>Industry<select name="industry" required>${INDUSTRY_PACKS.map((p) => html`<option value="${p.id}"${v.industry === p.id ? html` selected` : ""}>${p.name}</option>`)}</select></label>
      <label>Your name<input name="name" required maxlength="120" autocomplete="name" value="${v.name ?? ""}"></label>
      <label>Email<input name="email" type="email" required autocomplete="email" value="${v.email ?? ""}"></label>
      <label>Password <span class="hint">(12 or more characters)</span><input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="pilot" value="yes" required${v.pilot === "yes" ? html` checked` : ""}><span>I understand this is a pilot: agents work in simulation until I connect my accounts.</span></label>
      <label class="check"><input type="checkbox" name="marketing" value="yes"${v.marketing === "yes" ? html` checked` : ""}><span>${MARKETING_CONSENT_WORDING} <span class="hint">(optional)</span></span></label>
      <button class="btn primary wide" type="submit">Start my pilot workspace</button>
    </form>` : html`<div class="signup closed"><h3>Sign-ups are paused</h3><p>New pilot workspaces are closed for the moment. Existing customers can <a href="/login">sign in</a>.</p></div>`}
  </div>
</section>

<section id="faq" class="section" aria-labelledby="faq-title">
  <div class="wrap narrow">
    <h2 id="faq-title">Questions</h2>
    ${([
      ["What does it cost?", "Prices are announced before billing starts. You'll see the price for your plan and agree to it before you're ever charged."],
      ["Will it message my customers on its own?", "Not during the pilot: nothing leaves until you connect your accounts. After that, only messages your rules allow; everything else waits for your OK."],
      ["Who can see my business data?", "Only the people you invite. Each business has its own workspace, separated in the database itself, and your customers' details are never given to the marketing agents."],
      ["Does it work with my CONARO profile?", "Yes. Requests and bookings from the CONARO marketplace can flow in once your profile is linked, and the marketplace keeps handling its own quotes, payments and reviews."],
      ["Does it replace my accountant?", "No. It keeps your records tidy and prepares GST/HST summaries and estimates. Filing is done by you or your accountant."],
      ["Can I change plans or stop?", "Yes, at any time from Plan and usage. One button pauses every agent instantly."],
    ] as [string, string][]).map(([q, a]) => html`<details class="faq"><summary>${q}</summary><p>${a}</p></details>`)}
  </div>
</section>
</main>
<footer class="site-footer band-navy">
  <div class="wrap foot">
    <p><b>CONARO Business AI</b> · Greater Moncton, New Brunswick</p>
    <p class="small">Part of <a href="https://www.conaro.ca">CONARO</a> · <a href="/login">Sign in</a> · <span class="placeholder-text">Privacy notice and terms: to be published before launch</span></p>
  </div>
</footer>
</body></html>`.value;
}
