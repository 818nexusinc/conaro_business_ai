// CONARO Business AI — click-to-edit website editor. Loaded only on /admin/editor (signed-in platform admins).
// Click any outlined text to change it; click a photo to replace it; use the section tools to move or hide
// sections. Every change is saved as a draft at once; visitors see it only after "Publish".
(function () {
  "use strict";
  var bar = document.getElementById("ed-bar");
  if (!bar) return;
  var csrf = bar.getAttribute("data-csrf"), lang = bar.getAttribute("data-lang");
  var pending = Number(bar.getAttribute("data-pending") || 0), canPublish = bar.getAttribute("data-can-publish") === "1";
  var FR = lang === "fr";
  var t = function (en, fr) { return FR ? fr : en; };

  function api(path, body, headers) {
    var h = { "x-csrf": csrf };
    for (var k in headers || {}) h[k] = headers[k];
    if (!(body instanceof Blob)) { h["content-type"] = "application/json"; body = JSON.stringify(body); }
    return fetch(path, { method: "POST", headers: h, body: body, credentials: "same-origin" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
    });
  }

  // ---------------------------------------------------------------- toolbar
  bar.innerHTML = "";
  bar.setAttribute("role", "region"); bar.setAttribute("aria-label", t("Website editor", "Éditeur du site"));
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  var brand = el("span", "ed-brand", t("Editing", "Modification") + " · " + (FR ? "Français" : "English"));
  var status = el("span", "ed-status"); status.setAttribute("aria-live", "polite");
  var other = el("a", "ed-btn ghost", FR ? "English" : "Français"); other.href = "/admin/editor?lang=" + (FR ? "en" : "fr");
  var live = el("a", "ed-btn ghost", t("View live site", "Voir le site en ligne")); live.href = "/?lang=" + lang; live.target = "_blank"; live.rel = "noopener";
  var back = el("a", "ed-btn ghost", t("Admin", "Admin")); back.href = "/admin/site";
  var pub = el("button", "ed-btn primary", t("Publish", "Publier")); pub.type = "button";
  [brand, status, other, live, back].forEach(function (e) { bar.appendChild(e); });
  if (canPublish) bar.appendChild(pub);
  function showStatus(msg, kind) {
    status.textContent = msg || (pending ? t(pending + " change" + (pending === 1 ? "" : "s") + " waiting to publish", pending + " modification" + (pending === 1 ? "" : "s") + " à publier") : t("Everything is published", "Tout est publié"));
    status.className = "ed-status" + (kind ? " " + kind : "");
    pub.disabled = pending === 0;
  }
  showStatus();
  pub.addEventListener("click", function () {
    pub.disabled = true; showStatus(t("Publishing…", "Publication…"));
    api("/admin/api/publish", {}).then(function (j) { pending = 0; showStatus(t("Published " + j.published + " change(s). Visitors now see them.", j.published + " modification(s) publiée(s)."), "ok"); })
      .catch(function (e) { showStatus(e.message, "bad"); pub.disabled = false; });
  });

  // Links and buttons on the page do nothing while you edit text in them.
  document.addEventListener("click", function (e) {
    var ed = e.target.closest && e.target.closest(".ed");
    if (ed) { e.preventDefault(); e.stopPropagation(); ed.focus(); }
  }, true);

  // ---------------------------------------------------------------- text
  Array.prototype.forEach.call(document.querySelectorAll("[data-edit]"), function (node) {
    node.setAttribute("contenteditable", "true");
    node.setAttribute("spellcheck", "true");
    node.setAttribute("role", "textbox");
    node.setAttribute("aria-label", t("Edit text: ", "Modifier le texte : ") + node.getAttribute("data-edit"));
    var before = node.textContent;
    node.addEventListener("focus", function () { before = node.textContent; });
    node.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); node.blur(); }
      if (e.key === "Escape") { node.textContent = before; node.blur(); }
    });
    node.addEventListener("keyup", function (e) { e.stopPropagation(); });
    node.addEventListener("paste", function (e) {           // plain text only
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });
    node.addEventListener("blur", function () {
      var value = node.textContent.replace(/\s+/g, " ").trim();
      if (value === before.replace(/\s+/g, " ").trim()) return;
      if (!value) { node.textContent = before; showStatus(t("Text can't be empty.", "Le texte ne peut pas être vide."), "bad"); return; }
      node.classList.add("ed-saving");
      api("/admin/api/content", { key: node.getAttribute("data-edit"), lang: lang, value: value })
        .then(function (j) {
          pending = j.pending; node.classList.remove("ed-saving"); node.classList.add("ed-saved");
          setTimeout(function () { node.classList.remove("ed-saved"); }, 1200);
          Array.prototype.forEach.call(document.querySelectorAll('[data-edit="' + node.getAttribute("data-edit") + '"]'), function (n) { if (n !== node) n.textContent = value; });
          showStatus(t("Draft saved · ", "Brouillon enregistré · ") + (pending + t(" waiting to publish", " à publier")), "ok");
        })
        .catch(function (e) { node.classList.remove("ed-saving"); node.textContent = before; showStatus(e.message, "bad"); });
    });
  });

  // ---------------------------------------------------------------- photos
  var picker = el("input"); picker.type = "file"; picker.accept = "image/jpeg,image/png,image/webp"; picker.hidden = true; document.body.appendChild(picker);
  var target = null;
  Array.prototype.forEach.call(document.querySelectorAll("[data-edit-media]"), function (img) {
    img.setAttribute("tabindex", "0"); img.setAttribute("role", "button");
    img.setAttribute("aria-label", t("Replace photo: ", "Remplacer la photo : ") + img.getAttribute("data-edit-media"));
    img.title = t("Click to replace this photo", "Cliquez pour remplacer cette photo");
    function choose(e) { e.preventDefault(); e.stopPropagation(); target = img; picker.click(); }
    img.addEventListener("click", choose, true);
    img.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") choose(e); });
  });
  picker.addEventListener("change", function () {
    var file = picker.files && picker.files[0]; picker.value = "";
    if (!file || !target) return;
    if (file.size > 3 * 1024 * 1024) { showStatus(t("Images must be under 3 MB.", "Les images doivent faire moins de 3 Mo."), "bad"); return; }
    var img = target, key = img.getAttribute("data-edit-media");
    showStatus(t("Uploading…", "Téléversement…"));
    api("/admin/api/image", file, { "x-filename": file.name, "content-type": file.type })
      .then(function (j) { return api("/admin/api/content", { key: key, lang: "*", value: "u:" + j.id }).then(function (k) { return [j, k]; }); })
      .then(function (r) {
        pending = r[1].pending;
        Array.prototype.forEach.call(document.querySelectorAll('[data-edit-media="' + key + '"]'), function (i) { i.removeAttribute("srcset"); i.src = r[0].url; });
        showStatus(t("Photo replaced (draft) · ", "Photo remplacée (brouillon) · ") + (pending + t(" waiting to publish", " à publier")), "ok");
      })
      .catch(function (e) { showStatus(e.message, "bad"); });
  });

  // ---------------------------------------------------------------- sections: move up/down, hide/show
  var main = document.getElementById("main");
  function blocks() {
    return Array.prototype.map.call(main.querySelectorAll(":scope > [data-section], :scope > .ed-hidden-section"), function (n) {
      var s = n.matches("[data-section]") ? n : n.querySelector("[data-section]");
      return { node: n, id: s.getAttribute("data-section"), hidden: n.classList.contains("ed-hidden-section") };
    });
  }
  function saveLayout() {
    var b = blocks();
    var layout = { order: b.map(function (x) { return x.id; }), hidden: b.filter(function (x) { return x.hidden; }).map(function (x) { return x.id; }) };
    api("/admin/api/content", { key: "layout", lang: "*", value: JSON.stringify(layout) })
      .then(function (j) { pending = j.pending; showStatus(t("Layout saved (draft) · ", "Mise en page enregistrée (brouillon) · ") + (pending + t(" waiting to publish", " à publier")), "ok"); })
      .catch(function (e) { showStatus(e.message, "bad"); });
  }
  function tools() {
    Array.prototype.forEach.call(document.querySelectorAll(".ed-sec-tools"), function (x) { x.remove(); });
    blocks().forEach(function (b, i, all) {
      var box = el("div", "ed-sec-tools");
      var up = el("button", "", "↑"); up.type = "button"; up.disabled = i === 0; up.setAttribute("aria-label", t("Move section up", "Monter la section"));
      var down = el("button", "", "↓"); down.type = "button"; down.disabled = i === all.length - 1; down.setAttribute("aria-label", t("Move section down", "Descendre la section"));
      var hide = el("button", "", b.hidden ? t("Show", "Afficher") : t("Hide", "Masquer")); hide.type = "button";
      var label = el("span", "", "§ " + b.id + (b.hidden ? t(" (hidden)", " (masquée)") : ""));
      up.addEventListener("click", function () { main.insertBefore(b.node, all[i - 1].node); tools(); saveLayout(); });
      down.addEventListener("click", function () { main.insertBefore(all[i + 1].node, b.node); tools(); saveLayout(); });
      hide.addEventListener("click", function () {
        if (b.hidden) { var s = b.node.firstElementChild; main.insertBefore(s, b.node); b.node.remove(); }
        else { var w = el("div", "ed-hidden-section"); main.insertBefore(w, b.node); w.appendChild(b.node); }
        tools(); saveLayout();
      });
      [label, up, down, hide].forEach(function (x) { box.appendChild(x); });
      b.node.insertBefore(box, b.node.firstChild);
    });
  }
  tools();
})();
