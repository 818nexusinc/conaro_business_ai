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
})();
