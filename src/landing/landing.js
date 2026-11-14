// CONARO Business AI landing page: agent tabs and the speaking presenters. Progressive enhancement only:
// without this script every panel and full transcript is shown. Served from /static/landing.js
// (same origin, CSP script-src 'self'); no third-party code, nothing sent anywhere.
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  // ---------------------------------------------------------------- presenters
  var synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  var players = [];
  var NATURAL = /(natural|neural|premium|enhanced|online|wavenet|siri)/i;
  var POOR = /(compact|espeak|eloquence|novelty|whisper|zarvox|bells|bad news|trinoids)/i;

  function pickVoice(langTag) {
    if (!synth) return null;
    var base = langTag.slice(0, 2);
    var best = null, bestScore = -1e9;
    synth.getVoices().forEach(function (v) {
      var tag = (v.lang || "").replace("_", "-");
      if (tag.slice(0, 2).toLowerCase() !== base) return;
      var s = 0;
      if (tag.toLowerCase() === langTag.toLowerCase()) s += 3;          // en-CA / fr-CA first
      if (NATURAL.test(v.name)) s += 5;                                  // "Microsoft … Online (Natural)", "… Neural", "Premium"
      if (/google/i.test(v.name)) s += 3;                                // Chrome's network voices
      if (v.localService === false) s += 1;
      if (POOR.test(v.name)) s -= 6;
      if (s > bestScore) { best = v; bestScore = s; }
    });
    return best;
  }

  function Player(el) {
    this.el = el;
    this.lang = el.getAttribute("data-lang") || "en-CA";
    this.lines = Array.prototype.map.call(el.querySelectorAll("[data-lines] li"), function (li) { return li.textContent.trim(); });
    this.items = el.querySelectorAll("[data-lines] li");
    this.caption = el.querySelector("[data-caption]");
    this.stage = el.querySelector("[data-stage]");
    this.button = el.querySelector("[data-play]");
    this.voiceEl = el.querySelector("[data-voice]");
    this.audioSrc = el.getAttribute("data-audio");
    this.playing = false; this.index = 0; this.timer = null; this.audio = null;
    var self = this;
    if (this.button) this.button.addEventListener("click", function () { self.playing ? self.stop(true) : self.play(); });
  }
  Player.prototype.label = function (state) {
    if (!this.button) return;
    var text = this.button.getAttribute("data-label-" + state);
    this.button.querySelector("span").textContent = text;
    this.button.setAttribute("aria-pressed", state === "pause" ? "true" : "false");
  };
  Player.prototype.show = function (i) {
    this.index = i;
    if (this.caption) this.caption.textContent = this.lines[i] || "";
    for (var k = 0; k < this.items.length; k++) {
      if (k === i) this.items[k].setAttribute("aria-current", "true"); else this.items[k].removeAttribute("aria-current");
    }
  };
  Player.prototype.setSpeaking = function (on) { if (this.stage) this.stage.classList.toggle("speaking", on); };
  Player.prototype.note = function (text) { if (this.voiceEl) this.voiceEl.textContent = text; };
  Player.prototype.play = function () {
    players.forEach(function (p) { if (p.playing) p.stop(false); });
    this.playing = true; this.label("pause"); this.setSpeaking(true);
    if (this.audioSrc) return this.playAudio();
    if (synth) return this.speak(0);
    return this.captionsOnly(0);
  };
  Player.prototype.finish = function () {
    this.playing = false; this.setSpeaking(false); this.label("replay");
    if (this.caption) this.caption.textContent = this.lines[0] || "";
    for (var k = 0; k < this.items.length; k++) this.items[k].removeAttribute("aria-current");
  };
  Player.prototype.stop = function (byUser) {
    this.playing = false;
    if (this.audio) this.audio.pause();
    if (synth) synth.cancel();
    clearTimeout(this.timer);
    this.setSpeaking(false); this.label(byUser ? "play" : "play");
  };
  // Recorded narration (natural human voice): captions follow the audio, line by line by length.
  Player.prototype.playAudio = function () {
    var self = this;
    if (!this.audio) {
      this.audio = new Audio(this.audioSrc);
      var words = this.lines.map(function (l) { return l.split(/\s+/).length; });
      var total = words.reduce(function (a, b) { return a + b; }, 0);
      this.audio.addEventListener("timeupdate", function () {
        if (!self.audio.duration) return;
        var at = self.audio.currentTime / self.audio.duration * total, acc = 0;
        for (var i = 0; i < words.length; i++) { acc += words[i]; if (at < acc) { if (i !== self.index) self.show(i); break; } }
      });
      this.audio.addEventListener("ended", function () { self.finish(); });
      this.audio.addEventListener("error", function () { self.audioSrc = null; self.audio = null; if (self.playing) { synth ? self.speak(0) : self.captionsOnly(0); } });
    }
    this.note(this.voiceEl ? this.voiceEl.getAttribute("data-recorded") : "");
    this.show(0);
    this.audio.currentTime = 0;
    var p = this.audio.play();
    if (p && p.catch) p.catch(function () { self.audioSrc = null; self.audio = null; if (self.playing) { synth ? self.speak(0) : self.captionsOnly(0); } });
  };
  // The device's own voice, chosen for naturalness, one caption line per utterance.
  Player.prototype.speak = function (i) {
    var self = this;
    if (!this.playing) return;
    if (i >= this.lines.length) return this.finish();
    var voice = pickVoice(this.lang);
    if (!voice && synth.getVoices().length > 0) return this.captionsOnly(i);
    if (i === 0) this.note(voice ? this.voiceEl.getAttribute("data-device").replace("{v}", voice.name.replace(/^Microsoft /, "").replace(/ - .*$/, "")) : "");
    this.show(i);
    var u = new SpeechSynthesisUtterance(this.lines[i]);
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : this.lang;
    u.rate = 0.97; u.pitch = 1;
    u.onend = function () { if (self.playing) self.speak(i + 1); };
    u.onerror = function (e) { if (self.playing && e.error !== "interrupted" && e.error !== "canceled") self.captionsOnly(i); };
    synth.speak(u);
  };
  // No voice available: captions advance at a natural reading pace.
  Player.prototype.captionsOnly = function (i) {
    var self = this;
    if (i === 0 || !this.voiceNoted) { this.note(this.voiceEl ? this.voiceEl.getAttribute("data-none") : ""); this.voiceNoted = true; }
    if (!this.playing) return;
    if (i >= this.lines.length) return this.finish();
    this.show(i);
    this.timer = setTimeout(function () { self.captionsOnly(i + 1); }, Math.max(2200, this.lines[i].split(/\s+/).length * 400));
  };

  Array.prototype.forEach.call(document.querySelectorAll("[data-player]:not([data-video])"), function (el) { players.push(new Player(el)); });
  if (synth && synth.getVoices().length === 0 && "onvoiceschanged" in synth) synth.onvoiceschanged = function () {};
  window.addEventListener("pagehide", function () { if (synth) synth.cancel(); });

  // ---------------------------------------------------------------- tabs
  Array.prototype.forEach.call(document.querySelectorAll("[data-tabs]"), function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
    function select(i, focus) {
      tabs.forEach(function (t, k) {
        var on = k === i;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
      });
      players.forEach(function (p) { if (p.playing && root.contains(p.el)) p.stop(false); });
      // Phones show the tabs as a horizontal strip: bring the selected one into view without moving the page.
      var list = tabs[i].parentElement;
      if (list.scrollWidth > list.clientWidth) list.scrollLeft += tabs[i].getBoundingClientRect().left - list.getBoundingClientRect().left - 16;
      if (focus) tabs[i].focus({ preventScroll: list.scrollWidth > list.clientWidth });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function (e) { e.preventDefault(); select(i, false); if (history.replaceState) history.replaceState(null, "", "#" + panels[i].id); });
      t.addEventListener("keydown", function (e) {
        var n = tabs.length, to = null;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") to = (i + 1) % n;
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = (i - 1 + n) % n;
        else if (e.key === "Home") to = 0;
        else if (e.key === "End") to = n - 1;
        else if (e.key === " " || e.key === "Enter") { e.preventDefault(); select(i, false); return; }
        if (to !== null) { e.preventDefault(); select(to, true); }
      });
    });
    var fromHash = panels.findIndex(function (p) { return p && "#" + p.id === location.hash; });
    var initial = fromHash >= 0 ? fromHash : Math.max(0, tabs.findIndex(function (t) { return t.getAttribute("aria-selected") === "true"; }));
    select(initial, false);
  });
  // ---------------------------------------------------------------- motion and the page's interactions
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Header: transparent over the hero, solid once the page scrolls.
  var header = document.querySelector("[data-header]");
  function onScrollHeader() { if (header) header.classList.toggle("scrolled", window.scrollY > 40); }
  onScrollHeader();

  // Hero video: plays muted in a loop unless the visitor prefers less motion; the button pauses it (WCAG 2.2.2).
  var video = document.querySelector("[data-hero-video]");
  var toggle = document.querySelector("[data-video-toggle]");
  function setToggle(playing) {
    if (!toggle) return;
    toggle.setAttribute("aria-label", toggle.getAttribute(playing ? "data-label-pause" : "data-label-play"));
    toggle.querySelector("path").setAttribute("d", playing ? "M8 5v14M16 5v14" : "M8 5l11 7-11 7z");
  }
  if (video) {
    if (still) { setToggle(false); }
    else { var pv = video.play(); if (pv && pv.catch) pv.catch(function () { setToggle(false); }); setToggle(true); }
    var hero = video.closest(".hero");
    if (still && hero) hero.classList.add("still");
    // One button stops all background motion: the video and the moving list of trades.
    if (toggle) toggle.addEventListener("click", function () {
      if (video.paused) { video.play(); setToggle(true); if (hero) hero.classList.remove("still"); }
      else { video.pause(); setToggle(false); if (hero) hero.classList.add("still"); }
    });
  }

  // Reveal sections as they come into view.
  var reveal = document.querySelectorAll("[data-reveal]");
  if (!still && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
    reveal.forEach(function (el) { io.observe(el); });
  } else reveal.forEach(function (el) { el.classList.add("in"); });

  // Timeline progress line and gentle photo parallax, one frame at a time.
  var timeline = document.querySelector("[data-timeline]");
  var progress = document.querySelector("[data-progress]");
  var parallax = document.querySelectorAll("[data-parallax] img");
  var ticking = false;
  function frame() {
    ticking = false;
    onScrollHeader();
    if (still) return;
    var vh = window.innerHeight;
    if (timeline && progress) {
      var r = timeline.getBoundingClientRect();
      var p = Math.min(1, Math.max(0, (vh * 0.6 - r.top) / r.height));
      progress.style.setProperty("--p", p.toFixed(3));
    }
    parallax.forEach(function (img) {
      var b = img.parentElement.getBoundingClientRect();
      if (b.bottom < 0 || b.top > vh) return;
      var t = (b.top + b.height / 2 - vh / 2) / vh;           // -1 … 1 across the screen
      img.style.setProperty("--py", (-6 - t * 6).toFixed(2) + "%");
    });
  }
  window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
  frame();

  // Plans: choosing one selects it in the form and slides the sign-up panel open under the plans.
  var start = document.querySelector("[data-start]");
  Array.prototype.forEach.call(document.querySelectorAll("[data-choose]"), function (a) {
    a.addEventListener("click", function (e) {
      if (!start) return;
      e.preventDefault();
      var id = a.getAttribute("data-choose");
      var radio = start.querySelector('input[name="plan"][value="' + id + '"]');
      if (radio) radio.checked = true;
      Array.prototype.forEach.call(document.querySelectorAll("[data-plan-card]"), function (card) { card.classList.toggle("chosen", card.getAttribute("data-plan-card") === id); });
      start.classList.add("open");
      if (history.replaceState) history.replaceState(null, "", "#start");
      setTimeout(function () {
        start.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
        var first = start.querySelector('input[name="business"]');
        if (first) first.focus({ preventScroll: true });
      }, still ? 0 : 350);
    });
  });
  // The radio buttons inside the form keep the cards in step.
  if (start) start.addEventListener("change", function (e) {
    if (e.target.name !== "plan") return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-plan-card]"), function (card) { card.classList.toggle("chosen", card.getAttribute("data-plan-card") === e.target.value); });
  });
  if (start && location.hash === "#start") start.classList.add("open");
  // Any link to #start (header, hero) opens the panel too.
  Array.prototype.forEach.call(document.querySelectorAll('a[href$="#start"]:not([data-choose])'), function (a) { a.addEventListener("click", function () { if (start) start.classList.add("open"); }); });
})();
