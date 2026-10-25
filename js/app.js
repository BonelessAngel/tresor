// Oberfläche: Ansichten, Liste, Dialoge, Kopieren, automatisches Sperren.

import * as vault from "./vault.js";
import { requestPersist } from "./storage.js";
import { generate, strength } from "./generator.js";
import { analyze } from "./security.js";
import * as bio from "./biometric.js";

const $ = (sel) => document.querySelector(sel);
const CLIPBOARD_CLEAR_MS = 30000;
const finePointer = () => matchMedia("(pointer: fine)").matches;

// Eintragsarten: welche Felder es gibt und wie sie heißen.
const TYPES = {
  login: { icon: "", user: "Benutzername / E-Mail", pass: "Passwort", url: true },
  wifi: { icon: "📶", user: "Netzwerkname (SSID)", pass: "WLAN-Passwort", url: false },
  pin: { icon: "🔢", user: null, pass: "PIN", url: false },
  note: { icon: "📝", user: null, pass: null, url: false },
};
const typeOf = (e) => TYPES[e.type] ? e.type : "login";

const state = {
  folder: "all", // "all" | "fav" | "none" | Ordner-ID
  search: "",
  sel: 0, // per Tastatur ausgewählter Eintrag
  visible: [],
  viewing: null,
  lockTimer: null,
  hiddenAt: 0,
  clipTimer: null,
  genTarget: null,
};

// ---------- Einstellungen (nur Komfort, nicht geheim) ----------

function setting(name, fallback) {
  try {
    const v = localStorage.getItem("tresor." + name);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setSetting(name, value) {
  try { localStorage.setItem("tresor." + name, JSON.stringify(value)); } catch {}
}

// ---------- Hilfen ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v; // per CSSOM, CSP-konform
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function show(view) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + view;
}

function closeAllDialogs() {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}

function colorFor(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  const u = safeUrl(url);
  return u ? new URL(u).hostname.replace(/^www\./, "") : "";
}

function paintMeter(meterEl, pw, labelEl) {
  const s = strength(pw);
  meterEl.dataset.level = s.level;
  if (labelEl) labelEl.textContent = pw ? `Stärke: ${s.label} (~${s.bits} Bit)` : labelEl.dataset.default;
}

async function busy(button, label, fn) {
  if (!button) return fn();
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

// ---------- Zwischenablage ----------

// Ausweichweg für Browser ohne Clipboard-API-Erlaubnis.
function legacyCopy(text) {
  const ta = el("textarea", { readonly: "", style: "position:fixed;top:0;left:0;opacity:0" });
  ta.value = text;
  const focused = document.activeElement;
  (document.querySelector("dialog[open]") || document.body).append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  ta.remove();
  focused?.focus({ preventScroll: true }); // z. B. Cursor zurück in die Suche
  return ok;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

async function copy(text, what, entryId) {
  if (!text) return toast(`${what} ist leer`);
  if (!(await writeClipboard(text))) return toast("Kopieren nicht möglich");
  toast(`${what} kopiert – wird in 30 s geleert`);
  if (entryId) vault.markUsed(entryId);
  clearTimeout(state.clipTimer);
  // Kein readText(): das würde auf dem iPhone eine Einfügen-Abfrage zeigen.
  state.clipTimer = setTimeout(() => writeClipboard(" "), CLIPBOARD_CLEAR_MS);
}

// ---------- Automatisch sperren ----------

function autolockMs() {
  return setting("autolock", 5) * 60000;
}

function resetLockTimer() {
  if (!vault.isUnlocked()) return;
  clearTimeout(state.lockTimer);
  state.lockTimer = setTimeout(lock, autolockMs());
}

function lock() {
  clearTimeout(state.lockTimer);
  vault.lock();
  closeAllDialogs();
  $("#entry-list").replaceChildren();
  $("#search").value = "";
  state.search = "";
  state.viewing = null;
  $("#unlock-pw").value = "";
  $("#unlock-error").textContent = "";
  showUnlock();
}

async function showUnlock() {
  show("unlock");
  const bioOn = await bio.isEnabled();
  $("#unlock-bio-box").hidden = !bioOn;
  $("#unlock-bio").textContent = `🙂 Mit ${bio.deviceLabel()} entsperren`;
  // Mit Face ID kein Passwortfeld fokussieren, sonst springt am Handy die Tastatur auf.
  if (!bioOn || finePointer()) $("#unlock-pw").focus();
}

for (const ev of ["pointerdown", "keydown", "input"]) {
  document.addEventListener(ev, resetLockTimer, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.hiddenAt = Date.now();
  } else if (vault.isUnlocked() && Date.now() - state.hiddenAt > autolockMs()) {
    lock();
  }
});

// ---------- Start ----------

async function boot() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.textContent = "Diese App braucht eine sichere Verbindung (https oder localhost).";
    return;
  }
  if (await vault.hasVault()) {
    showUnlock();
  } else {
    show("setup");
  }
}

function enterMain() {
  requestPersist();
  show("main");
  $("#sort").value = setting("sort", "recent");
  state.sel = 0;
  renderAll();
  resetLockTimer();
  if (finePointer()) $("#search").focus(); // am Handy würde sonst die Tastatur aufgehen
}

const UPGRADE_MSG = "Tresor auf stärkere Verschlüsselung (Argon2id) umgestellt – bitte neu exportieren";

// ---------- Ersteinrichtung ----------

$("#setup-strength").dataset.default = $("#setup-strength").textContent;
$("#setup-pw").addEventListener("input", (e) => paintMeter($("#setup-meter"), e.target.value, $("#setup-strength")));

$("#setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#setup-pw").value;
  const err = $("#setup-error");
  if (pw.length < 10) return (err.textContent = "Bitte mindestens 10 Zeichen.");
  if (pw !== $("#setup-pw2").value) return (err.textContent = "Die Passwörter stimmen nicht überein.");
  err.textContent = "";
  await busy(e.submitter, "Lege an …", () => vault.create(pw));
  $("#setup-pw").value = $("#setup-pw2").value = "";
  enterMain();
  toast("Tresor angelegt");
});

$("#setup-import").addEventListener("click", async () => {
  const blob = await pickFile();
  if (!blob) return;
  let upgraded = false;
  const ok = await promptDialog({
    title: "Tresor-Datei öffnen",
    fields: [{ id: "pw", label: "Masterpasswort der Datei", type: "password", autocomplete: "current-password" }],
    okLabel: "Öffnen",
    onSubmit: async ({ pw }) => {
      try {
        upgraded = await vault.adoptBlob(blob, pw);
      } catch {
        throw new Error("Falsches Passwort oder ungültige Datei.");
      }
    },
  });
  if (ok) {
    enterMain();
    toast(upgraded ? UPGRADE_MSG : "Tresor geladen");
  }
});

// ---------- Entsperren ----------

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#unlock-error");
  err.textContent = "";
  let upgraded;
  try {
    upgraded = await busy(e.submitter, "Entsperre …", () => vault.unlock($("#unlock-pw").value));
  } catch {
    err.textContent = "Falsches Masterpasswort.";
    $("#unlock-pw").select();
    return;
  }
  $("#unlock-pw").value = "";
  enterMain();
  if (upgraded) toast(UPGRADE_MSG);
});

$("#unlock-bio").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const err = $("#unlock-error");
  err.textContent = "";
  let pw;
  try {
    pw = await bio.unlockPassword();
  } catch (ex) {
    err.textContent = bio.errorMessage(ex);
    return;
  }
  let upgraded;
  try {
    upgraded = await busy(button, "Entsperre …", () => vault.unlock(pw));
  } catch {
    // Passiert, wenn das Masterpasswort auf einem anderen Weg geändert wurde.
    await bio.disable();
    $("#unlock-bio-box").hidden = true;
    err.textContent = `Das Masterpasswort hat sich geändert. Bitte damit entsperren und ${bio.deviceLabel()} neu einrichten.`;
    return;
  }
  enterMain();
  if (upgraded) toast(UPGRADE_MSG);
});

// ---------- Hauptansicht ----------

$("#btn-lock").addEventListener("click", lock);
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value.trim().toLowerCase();
  state.sel = 0;
  renderList();
});
$("#sort").addEventListener("change", (e) => {
  setSetting("sort", e.target.value);
  renderList();
});
$("#btn-add").addEventListener("click", () => openEdit(null));
$("#btn-generator").addEventListener("click", () => openGenerator(null));
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-security").addEventListener("click", openSecurity);

function renderAll() {
  renderChips();
  renderList();
  renderSecurityBadge();
}

function folderName(id) {
  return vault.folders().find((f) => f.id === id)?.name || "";
}

function renderChips() {
  const folders = vault.folders();
  const hasFav = vault.entries().some((e) => e.favorite);
  if (state.folder === "fav" && !hasFav) state.folder = "all";
  if (!["all", "fav", "none"].includes(state.folder) && !folders.some((f) => f.id === state.folder)) {
    state.folder = "all";
  }
  const hasLoose = vault.entries().some((e) => !folderName(e.folder));
  const chips = [["all", "Alle"]];
  if (hasFav) chips.push(["fav", "⭐ Favoriten"]);
  chips.push(...folders.map((f) => [f.id, f.name]));
  if (folders.length && hasLoose) chips.push(["none", "Ohne Ordner"]);

  $("#folder-chips").hidden = chips.length < 2;
  $("#folder-chips").replaceChildren(
    ...chips.map(([id, name]) =>
      el("button", {
        class: "chip",
        "aria-pressed": String(state.folder === id),
        onclick: () => {
          state.folder = id;
          state.sel = 0;
          renderAll();
        },
      }, name)
    )
  );
}

function matches(e) {
  if (state.folder === "fav" && !e.favorite) return false;
  if (state.folder === "none" && folderName(e.folder)) return false;
  if (!["all", "fav", "none"].includes(state.folder) && e.folder !== state.folder) return false;
  if (!state.search) return true;
  return [e.title, e.username, e.url, e.notes].some((v) => v?.toLowerCase().includes(state.search));
}

// Favoriten immer oben, danach je nach Auswahl zuletzt benutzt oder alphabetisch.
function sorted(list) {
  const recent = $("#sort").value === "recent";
  return [...list].sort((a, b) =>
    (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) ||
    (recent ? (b.lastUsed || 0) - (a.lastUsed || 0) : 0) ||
    a.title.localeCompare(b.title, "de")
  );
}

function iconButton(symbol, label, onclick) {
  return el("button", { class: "icon-btn", title: label, "aria-label": label, onclick }, symbol);
}

// Kopiert das Passwort und öffnet die Webseite in einem neuen Tab.
function openAndCopy(e) {
  const url = safeUrl(e.url);
  if (!url) return;
  copy(e.password, "Passwort", e.id);
  window.open(url, "_blank", "noopener,noreferrer");
}

function itemButtons(e) {
  const t = TYPES[typeOf(e)];
  const buttons = [];
  if (t.user && typeOf(e) === "login") buttons.push(iconButton("👤", "Benutzername kopieren", () => copy(e.username, "Benutzername", e.id)));
  if (t.url && safeUrl(e.url)) buttons.push(iconButton("🌐", "Webseite öffnen + Passwort kopieren", () => openAndCopy(e)));
  if (t.pass) buttons.push(iconButton("🔑", `${t.pass} kopieren`, () => copy(e.password, t.pass, e.id)));
  return buttons;
}

function subtitle(e) {
  const type = typeOf(e);
  if (type === "note") return (e.notes || "").split("\n")[0];
  if (type === "pin") return "PIN";
  return e.username || hostOf(e.url) || " ";
}

function renderList() {
  const all = vault.entries();
  const list = sorted(all.filter(matches));
  state.visible = list;
  state.sel = Math.min(state.sel, Math.max(list.length - 1, 0));
  $("#entry-list").replaceChildren(
    ...list.map((e, i) => {
      const icon = TYPES[typeOf(e)].icon;
      const selected = i === state.sel && (state.search || state.kbd) && finePointer();
      return el("li", { class: "item" + (selected ? " selected" : "") },
        el("button", { class: "item-main", onclick: () => openView(e.id) },
          icon
            ? el("span", { class: "avatar emoji" }, icon)
            : el("span", { class: "avatar", style: `background:${colorFor(e.title)}` }, (e.title[0] || "?").toUpperCase()),
          el("span", { class: "item-text" },
            el("div", { class: "item-title" }, e.title, e.favorite ? el("span", { class: "star", "aria-label": "Favorit" }, "★") : null),
            el("div", { class: "item-sub" }, subtitle(e))
          )
        ),
        ...itemButtons(e)
      );
    })
  );
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  empty.textContent = all.length ? "Keine Treffer." : "Noch keine Einträge. Tippe auf ＋, um den ersten anzulegen.";
}

// ---------- Tastatur (PC) ----------

function moveSelection(delta) {
  if (!state.visible.length) return;
  state.sel = (state.sel + delta + state.visible.length) % state.visible.length;
  renderList();
  $("#entry-list .selected")?.scrollIntoView({ block: "nearest" });
}

$("#search").addEventListener("keydown", (e) => {
  const entry = state.visible[state.sel];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!state.kbd) {
      state.kbd = true; // erster Pfeil zeigt nur die Auswahl an
      renderList();
    } else {
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
    }
  } else if (e.key === "Enter" && entry) {
    e.preventDefault();
    const t = TYPES[typeOf(entry)];
    if (e.ctrlKey || e.metaKey) openAndCopy(entry);
    else if (e.shiftKey) copy(entry.username, "Benutzername", entry.id);
    else if (t.pass) copy(entry.password, t.pass, entry.id);
    else openView(entry.id);
  } else if (e.key === "Escape") {
    e.target.value = "";
    state.search = "";
    state.sel = 0;
    state.kbd = false;
    renderList();
  }
});

document.addEventListener("keydown", (e) => {
  if ($("#view-main").hidden || document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
    e.preventDefault();
    $("#search").focus();
    $("#search").select();
  }
});

// ---------- Eintrag ansehen ----------

function field(label, value, { secret = false, mono = false, copyAs, entryId, link } = {}) {
  if (!value) return null;
  const val = el("span", { class: "val" + (mono ? " mono" : "") });
  let shown = !secret;
  const paint = () => (val.textContent = shown ? value : "••••••••••••");
  paint();
  if (link) val.replaceChildren(el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, value));
  return el("div", { class: "field" },
    el("div", { class: "field-label" }, label),
    el("div", { class: "field-value" },
      val,
      secret ? el("button", { class: "icon-btn", "aria-label": "Anzeigen", onclick: () => { shown = !shown; paint(); } }, "👁") : null,
      copyAs ? el("button", { class: "icon-btn", "aria-label": "Kopieren", onclick: () => copy(value, copyAs, entryId) }, "📋") : null
    )
  );
}

function paintFav(e) {
  $("#view-fav").textContent = e.favorite ? "★" : "☆";
  $("#view-fav").title = e.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten";
}

function openView(id) {
  const e = vault.getEntry(id);
  if (!e) return;
  const t = TYPES[typeOf(e)];
  state.viewing = id;
  $("#view-title").textContent = e.title;
  paintFav(e);
  const fmt = (ts) => new Date(ts).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
  const notes = e.notes ? el("div", { class: "field" }, el("div", { class: "field-label" }, "Notizen"), el("div", { class: "notes" }, e.notes)) : null;
  const url = safeUrl(e.url);
  $("#view-body").replaceChildren(
    ...[
      t.user ? field(t.user, e.username, { copyAs: t.user, entryId: id }) : null,
      t.pass ? field(t.pass, e.password, { secret: true, mono: true, copyAs: t.pass, entryId: id }) : null,
      t.url ? field("Webseite", e.url, { link: url }) : null,
      t.url && url ? el("button", { class: "btn block", onclick: () => openAndCopy(e) }, "🌐 Öffnen + Passwort kopieren") : null,
      field("Ordner", folderName(e.folder)),
      notes,
      e.history?.length ? field("Frühere Passwörter", `${e.history.length} gespeichert (zuletzt geändert ${fmt(e.history[0].changed)})`) : null,
      el("p", { class: "muted small" }, `Zuletzt geändert: ${fmt(e.updated)}`),
    ].filter(Boolean)
  );
  $("#dlg-view").showModal();
}

$("#view-fav").addEventListener("click", async () => {
  await vault.toggleFavorite(state.viewing);
  paintFav(vault.getEntry(state.viewing));
  renderAll();
});

$("#view-edit").addEventListener("click", () => {
  $("#dlg-view").close();
  openEdit(state.viewing);
});

$("#view-delete").addEventListener("click", async () => {
  const e = vault.getEntry(state.viewing);
  if (!e || !confirm(`„${e.title}“ wirklich löschen?`)) return;
  await vault.deleteEntry(e.id);
  $("#dlg-view").close();
  renderAll();
  toast("Eintrag gelöscht");
});

// ---------- Eintrag bearbeiten ----------

const NEW_FOLDER = "__new__";

function fillFolderSelect(selected) {
  $("#edit-folder").replaceChildren(
    el("option", { value: "" }, "Kein Ordner"),
    ...vault.folders().map((f) => el("option", { value: f.id }, f.name)),
    el("option", { value: NEW_FOLDER }, "＋ Neuer Ordner …")
  );
  $("#edit-folder").value = folderName(selected) ? selected : "";
}

const editType = () => document.querySelector('#edit-type input:checked').value;

// Blendet je nach Art die passenden Felder ein und benennt sie.
function applyEditType() {
  const type = editType();
  const t = TYPES[type];
  $("#f-username").hidden = !t.user;
  $("#l-username").textContent = t.user || "";
  $("#f-password").hidden = !t.pass;
  $("#f-meter").hidden = !t.pass || type === "pin";
  $("#l-password").textContent = t.pass || "";
  $("#edit-password").inputMode = type === "pin" ? "numeric" : "text";
  $("#f-url").hidden = !t.url;
  $("#edit-notes").rows = type === "note" ? 8 : 3;
  $("#edit-title").placeholder = { login: "z. B. Amazon", wifi: "z. B. WLAN Zuhause", pin: "z. B. Handy-PIN", note: "z. B. Notfallcodes" }[type];
}

for (const r of document.querySelectorAll('#edit-type input')) r.addEventListener("change", applyEditType);

function openEdit(id) {
  const e = id ? vault.getEntry(id) : null;
  state.editing = id;
  $("#edit-heading").textContent = e ? "Eintrag bearbeiten" : "Neuer Eintrag";
  document.querySelector(`#edit-type input[value="${e ? typeOf(e) : "login"}"]`).checked = true;
  $("#edit-title").value = e?.title || "";
  $("#edit-username").value = e?.username || "";
  $("#edit-password").value = e?.password || "";
  $("#edit-password").type = "password";
  $("#edit-url").value = e?.url || "";
  $("#edit-notes").value = e?.notes || "";
  const preset = e ? e.folder : ["all", "fav", "none"].includes(state.folder) ? "" : state.folder;
  fillFolderSelect(preset);
  applyEditType();
  paintMeter($("#edit-meter"), $("#edit-password").value);
  $("#dlg-edit").showModal();
  if (!e) $("#edit-title").focus();
}

$("#edit-password").addEventListener("input", (e) => paintMeter($("#edit-meter"), e.target.value));
$("#edit-toggle").addEventListener("click", () => {
  const p = $("#edit-password");
  p.type = p.type === "password" ? "text" : "password";
});
$("#edit-gen").addEventListener("click", () => {
  if (editType() !== "pin") return openGenerator($("#edit-password"));
  const p = $("#edit-password");
  p.value = generate({ length: 6, lower: false, upper: false, digits: true, symbols: false, ambiguous: true });
  p.type = "text";
});

$("#edit-folder").addEventListener("change", async (e) => {
  if (e.target.value !== NEW_FOLDER) return;
  let created = null;
  await promptDialog({
    title: "Neuer Ordner",
    fields: [{ id: "name", label: "Name", type: "text" }],
    okLabel: "Anlegen",
    onSubmit: async ({ name }) => {
      if (!name.trim()) throw new Error("Bitte einen Namen eingeben.");
      created = await vault.addFolder(name.trim());
    },
  });
  fillFolderSelect(created?.id || "");
  renderChips();
});

$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = editType();
  const t = TYPES[type];
  // Felder, die zur Art nicht passen, werden geleert.
  const fields = {
    type,
    title: $("#edit-title").value.trim(),
    username: t.user ? $("#edit-username").value.trim() : "",
    password: t.pass ? $("#edit-password").value : "",
    url: t.url ? $("#edit-url").value.trim() : "",
    notes: $("#edit-notes").value,
    folder: $("#edit-folder").value === NEW_FOLDER ? "" : $("#edit-folder").value,
  };
  if (state.editing) fields.id = state.editing;
  await vault.saveEntry(fields);
  $("#dlg-edit").close();
  renderAll();
  toast("Gespeichert");
});

// ---------- Sicherheits-Check ----------

function renderSecurityBadge() {
  const { problems } = analyze(vault.entries());
  $("#security-badge").hidden = !problems;
  $("#security-badge").textContent = problems;
}

function openSecurity() {
  const r = analyze(vault.entries());
  const goTo = (id) => () => {
    $("#dlg-security").close();
    openView(id);
  };
  const group = (title, text, items) =>
    items.length
      ? el("div", { class: "sec-group" },
          el("h3", {}, `${title} (${items.length})`),
          el("p", { class: "muted small" }, text),
          el("ul", { class: "sec-list" },
            ...items.map(([entry, why]) => el("li", {}, el("button", { onclick: goTo(entry.id) }, el("span", {}, entry.title), el("span", { class: "why" }, why))))
          )
        )
      : null;

  const ageText = (e) => {
    const months = Math.floor((Date.now() - (e.pwChanged || e.created)) / (30 * 24 * 3600 * 1000));
    return months >= 24 ? `${Math.floor(months / 12)} Jahre` : `${months} Monate`;
  };

  const body = r.total
    ? [
        el("div", { class: "sec-score" },
          el("span", { class: "big " + (r.problems ? "bad" : "ok") }, `${r.ok}/${r.total}`),
          el("span", {}, r.problems ? "Passwörter sind in Ordnung. Tippe einen Eintrag an, um ihn zu verbessern." : "Alle Passwörter sind in Ordnung. 🎉")
        ),
        group("Mehrfach benutzt", "Wird eines davon geleakt, sind alle betroffen. Gib jedem Konto ein eigenes Passwort.",
          r.reused.flatMap((g, i) => g.map((e) => [e, `Gruppe ${i + 1} · ${g.length}×`]))),
        group("Schwach", "Zu kurz oder zu einfach. Nutze den Generator 🎲.",
          r.weak.map((e) => [e, strength(e.password).label])),
        group("Älter als 1 Jahr", "Bei wichtigen Konten lohnt sich ab und zu ein neues Passwort.",
          r.old.map((e) => [e, ageText(e)])),
        el("p", { class: "muted small" }, "PINs und Notizen werden nicht bewertet. Alles wird nur auf diesem Gerät geprüft."),
      ]
    : [el("p", { class: "muted" }, "Noch keine Passwörter zum Prüfen.")];

  $("#security-body").replaceChildren(...body.filter(Boolean));
  $("#dlg-security").showModal();
}

// ---------- Generator ----------

const genIds = ["lower", "upper", "digits", "symbols", "ambiguous"];

function genOptions() {
  const o = { length: Number($("#gen-length").value) };
  for (const id of genIds) o[id] = $("#gen-" + id).checked;
  return o;
}

function regenerate() {
  const o = genOptions();
  setSetting("generator", o);
  $("#gen-len-label").textContent = o.length;
  const pw = generate(o);
  $("#gen-output").textContent = pw || "Mindestens eine Zeichenart wählen";
  paintMeter($("#gen-meter"), pw);
}

function openGenerator(target) {
  state.genTarget = target;
  const o = setting("generator", null);
  if (o) {
    $("#gen-length").value = o.length;
    for (const id of genIds) $("#gen-" + id).checked = o[id];
  }
  $("#gen-use").hidden = !target;
  regenerate();
  $("#dlg-gen").showModal();
}

$("#gen-length").addEventListener("input", regenerate);
for (const id of genIds) $("#gen-" + id).addEventListener("change", regenerate);
$("#gen-refresh").addEventListener("click", regenerate);
$("#gen-copy").addEventListener("click", () => copy($("#gen-output").textContent, "Passwort"));
$("#gen-use").addEventListener("click", () => {
  const t = state.genTarget;
  t.value = $("#gen-output").textContent;
  t.dispatchEvent(new Event("input"));
  $("#dlg-gen").close();
});

// ---------- Einstellungen ----------

function renderFolderAdmin() {
  const folders = vault.folders();
  $("#folder-admin").replaceChildren(
    ...(folders.length
      ? folders.map((f) =>
          el("li", {},
            el("input", {
              value: f.name,
              "aria-label": "Ordnername",
              onchange: async (e) => {
                const name = e.target.value.trim();
                if (!name) return (e.target.value = f.name);
                await vault.renameFolder(f.id, name);
                renderAll();
              },
            }),
            el("button", {
              class: "icon-btn",
              "aria-label": "Ordner löschen",
              onclick: async () => {
                if (!confirm(`Ordner „${f.name}“ löschen? Die Einträge bleiben erhalten (ohne Ordner).`)) return;
                await vault.deleteFolder(f.id);
                renderFolderAdmin();
                renderAll();
              },
            }, "🗑")
          )
        )
      : [el("li", { class: "muted small" }, "Noch keine Ordner.")])
  );
}

function renderLastExport() {
  const t = setting("lastExport", 0);
  $("#last-export").textContent = t
    ? `Letzter Export auf diesem Gerät: ${new Date(t).toLocaleDateString("de-DE")}`
    : "Auf diesem Gerät wurde noch nie exportiert – mach regelmäßig ein Backup!";
}

function openSettings() {
  renderFolderAdmin();
  renderLastExport();
  $("#autolock").value = String(setting("autolock", 5));
  renderBioSection();
  $("#dlg-settings").showModal();
}

async function renderBioSection() {
  const label = bio.deviceLabel();
  $("#bio-section").hidden = !(await bio.isSupported());
  const on = await bio.isEnabled();
  $("#bio-status").textContent = on
    ? `✅ Entsperren mit ${label} ist auf diesem Gerät eingeschaltet.`
    : `Entsperre den Tresor mit ${label}, statt das Masterpasswort zu tippen. Wird pro Gerät eingerichtet.`;
  $("#btn-bio").textContent = on ? `${label} ausschalten` : `🙂 ${label} einrichten`;
  $("#btn-bio").dataset.on = on ? "1" : "";
}

$("#btn-bio").addEventListener("click", async () => {
  const label = bio.deviceLabel();
  if ($("#btn-bio").dataset.on) {
    if (!confirm(`${label} für den Tresor auf diesem Gerät ausschalten?`)) return;
    await bio.disable();
    toast(`${label} ausgeschaltet. Den Passkey „Tresor“ kannst du in der Passwörter-App löschen.`);
    return renderBioSection();
  }
  await promptDialog({
    title: `${label} einrichten`,
    fields: [{ id: "pw", label: "Zur Bestätigung: Masterpasswort", type: "password", autocomplete: "current-password" }],
    okLabel: "Einrichten",
    onSubmit: async ({ pw }) => {
      try {
        await bio.enable(pw, vault.checkPassword);
      } catch (ex) {
        throw new Error(bio.errorMessage(ex));
      }
      toast(`${label} eingerichtet 🎉`);
    },
  });
  renderBioSection();
});

$("#folder-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#folder-new").value.trim();
  if (!name) return;
  await vault.addFolder(name);
  $("#folder-new").value = "";
  renderFolderAdmin();
  renderAll();
});

$("#autolock").addEventListener("change", (e) => {
  setSetting("autolock", Number(e.target.value));
  resetLockTimer();
});

$("#btn-change-pw").addEventListener("click", () =>
  promptDialog({
    title: "Masterpasswort ändern",
    fields: [
      { id: "old", label: "Aktuelles Masterpasswort", type: "password", autocomplete: "current-password" },
      { id: "new1", label: "Neues Masterpasswort", type: "password", autocomplete: "new-password", meter: true },
      { id: "new2", label: "Neues wiederholen", type: "password", autocomplete: "new-password" },
    ],
    okLabel: "Ändern",
    onSubmit: async ({ old, new1, new2 }) => {
      if (new1.length < 10) throw new Error("Bitte mindestens 10 Zeichen.");
      if (new1 !== new2) throw new Error("Die neuen Passwörter stimmen nicht überein.");
      try {
        await vault.changePassword(old, new1);
      } catch {
        throw new Error("Das aktuelle Masterpasswort ist falsch.");
      }
      if (await bio.isEnabled()) {
        // Das gespeicherte Passwort für Face ID ist jetzt veraltet.
        await bio.disable();
        renderBioSection();
        toast(`Masterpasswort geändert – bitte ${bio.deviceLabel()} neu einrichten und neu exportieren`);
      } else {
        toast("Masterpasswort geändert – exportiere am besten neu");
      }
    },
  })
);

$("#btn-export").addEventListener("click", async () => {
  const blob = await vault.exportBlob();
  const name = `tresor-${new Date().toISOString().slice(0, 10)}.tresor`;
  const file = new File([JSON.stringify(blob)], name, { type: "application/json" });

  // Auf dem iPhone: Teilen-Menü (In Dateien sichern, AirDrop …). Am PC: Download.
  const mobile = matchMedia("(pointer: coarse)").matches;
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  } else {
    const url = URL.createObjectURL(file);
    el("a", { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  setSetting("lastExport", Date.now());
  renderLastExport();
  toast("Export erstellt");
});

$("#btn-import").addEventListener("click", async () => {
  const blob = await pickFile();
  if (!blob) return;
  await promptDialog({
    title: "Tresor-Datei importieren",
    fields: [{ id: "pw", label: "Masterpasswort der Datei", type: "password", autocomplete: "current-password" }],
    okLabel: "Zusammenführen",
    onSubmit: async ({ pw }) => {
      let n;
      try {
        n = await vault.importBlob(blob, pw);
      } catch (err) {
        throw new Error(err.message.startsWith("Keine") ? err.message : "Falsches Passwort oder beschädigte Datei.");
      }
      renderAll();
      renderFolderAdmin();
      toast(n ? `${n} Änderung(en) übernommen` : "Alles war schon aktuell");
    },
  });
});

// ---------- Datei wählen ----------

function pickFile() {
  return new Promise((resolve) => {
    const input = $("#file-input");
    input.value = "";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      try {
        resolve(JSON.parse(await f.text()));
      } catch {
        toast("Datei konnte nicht gelesen werden");
        resolve(null);
      }
    };
    input.click();
  });
}

// ---------- Passwort-Abfrage-Dialog ----------

function promptDialog({ title, fields, okLabel, onSubmit }) {
  const dlg = $("#dlg-prompt");
  const form = $("#prompt-form");
  $("#prompt-title").textContent = title;
  $("#prompt-ok").textContent = okLabel;
  $("#prompt-error").textContent = "";
  const inputs = {};
  $("#prompt-fields").replaceChildren(
    ...fields.flatMap((f) => {
      const input = el("input", { type: f.type, autocomplete: f.autocomplete || "off", required: "" });
      inputs[f.id] = input;
      const nodes = [el("label", {}, f.label, input)];
      if (f.meter) {
        const bar = el("span");
        input.addEventListener("input", () => paintMeter(bar, input.value));
        nodes.push(el("div", { class: "meter" }, bar));
      }
      return nodes;
    })
  );

  return new Promise((resolve) => {
    let done = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      try {
        await busy($("#prompt-ok"), "Bitte warten …", () => onSubmit(values));
      } catch (err) {
        $("#prompt-error").textContent = err.message;
        return;
      }
      done = true;
      dlg.close();
    };
    dlg.onclose = () => {
      for (const i of Object.values(inputs)) i.value = "";
      resolve(done);
    };
    dlg.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

// ---------- Dialoge allgemein ----------

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) e.target.closest("dialog")?.close();
  // Klick auf den Hintergrund schließt – außer bei Formularen, damit nichts Getipptes verloren geht.
  else if (e.target.tagName === "DIALOG" && !e.target.querySelector("form")) e.target.close();
});

boot();
