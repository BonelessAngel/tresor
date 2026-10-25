// Oberfläche: Ansichten, Liste, Dialoge, Kopieren, automatisches Sperren.

import * as vault from "./vault.js";
import { requestPersist } from "./storage.js";
import { generate, strength } from "./generator.js";

const $ = (sel) => document.querySelector(sel);
const CLIPBOARD_CLEAR_MS = 30000;

const state = {
  folder: "all", // "all" | "none" | Ordner-ID
  search: "",
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
  (document.querySelector("dialog[open]") || document.body).append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  ta.remove();
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

async function copy(text, what) {
  if (!text) return toast(`${what} ist leer`);
  if (!(await writeClipboard(text))) return toast("Kopieren nicht möglich");
  toast(`${what} kopiert – wird in 30 s geleert`);
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
  show("unlock");
  $("#unlock-pw").focus();
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
    show("unlock");
    $("#unlock-pw").focus();
  } else {
    show("setup");
  }
}

function enterMain() {
  requestPersist();
  show("main");
  renderAll();
  resetLockTimer();
}

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
  const ok = await promptDialog({
    title: "Tresor-Datei öffnen",
    fields: [{ id: "pw", label: "Masterpasswort der Datei", type: "password", autocomplete: "current-password" }],
    okLabel: "Öffnen",
    onSubmit: async ({ pw }) => {
      try {
        await vault.adoptBlob(blob, pw);
      } catch {
        throw new Error("Falsches Passwort oder ungültige Datei.");
      }
    },
  });
  if (ok) {
    enterMain();
    toast("Tresor geladen");
  }
});

// ---------- Entsperren ----------

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#unlock-error");
  err.textContent = "";
  try {
    await busy(e.submitter, "Entsperre …", () => vault.unlock($("#unlock-pw").value));
  } catch {
    err.textContent = "Falsches Masterpasswort.";
    $("#unlock-pw").select();
    return;
  }
  $("#unlock-pw").value = "";
  enterMain();
});

// ---------- Hauptansicht ----------

$("#btn-lock").addEventListener("click", lock);
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderList();
});
$("#btn-add").addEventListener("click", () => openEdit(null));
$("#btn-generator").addEventListener("click", () => openGenerator(null));
$("#btn-settings").addEventListener("click", openSettings);

function renderAll() {
  renderChips();
  renderList();
}

function folderName(id) {
  return vault.folders().find((f) => f.id === id)?.name || "";
}

function renderChips() {
  const folders = vault.folders();
  if (state.folder !== "all" && state.folder !== "none" && !folders.some((f) => f.id === state.folder)) {
    state.folder = "all";
  }
  const hasLoose = vault.entries().some((e) => !folderName(e.folder));
  const chips = [["all", "Alle"], ...folders.map((f) => [f.id, f.name])];
  if (folders.length && hasLoose) chips.push(["none", "Ohne Ordner"]);

  $("#folder-chips").hidden = !folders.length;
  $("#folder-chips").replaceChildren(
    ...chips.map(([id, name]) =>
      el("button", {
        class: "chip",
        "aria-pressed": String(state.folder === id),
        onclick: () => {
          state.folder = id;
          renderAll();
        },
      }, name)
    )
  );
}

function matches(e) {
  if (state.folder === "none" && folderName(e.folder)) return false;
  if (state.folder !== "all" && state.folder !== "none" && e.folder !== state.folder) return false;
  if (!state.search) return true;
  return [e.title, e.username, e.url, e.notes].some((v) => v?.toLowerCase().includes(state.search));
}

function renderList() {
  const all = vault.entries();
  const list = all.filter(matches);
  $("#entry-list").replaceChildren(
    ...list.map((e) =>
      el("li", { class: "item" },
        el("button", { class: "item-main", onclick: () => openView(e.id) },
          el("span", { class: "avatar", style: `background:${colorFor(e.title)}` }, (e.title[0] || "?").toUpperCase()),
          el("span", { class: "item-text" },
            el("div", { class: "item-title" }, e.title),
            el("div", { class: "item-sub" }, e.username || hostOf(e.url) || " ")
          )
        ),
        el("button", { class: "icon-btn", title: "Benutzername kopieren", "aria-label": "Benutzername kopieren", onclick: () => copy(e.username, "Benutzername") }, "👤"),
        el("button", { class: "icon-btn", title: "Passwort kopieren", "aria-label": "Passwort kopieren", onclick: () => copy(e.password, "Passwort") }, "🔑")
      )
    )
  );
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  empty.textContent = all.length ? "Keine Treffer." : "Noch keine Einträge. Tippe auf ＋, um den ersten anzulegen.";
}

// ---------- Eintrag ansehen ----------

function field(label, value, { secret = false, mono = false, copyAs, link } = {}) {
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
      copyAs ? el("button", { class: "icon-btn", "aria-label": "Kopieren", onclick: () => copy(value, copyAs) }, "📋") : null
    )
  );
}

function openView(id) {
  const e = vault.getEntry(id);
  if (!e) return;
  state.viewing = id;
  $("#view-title").textContent = e.title;
  const fmt = (t) => new Date(t).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
  const notes = e.notes ? el("div", { class: "field" }, el("div", { class: "field-label" }, "Notizen"), el("div", { class: "notes" }, e.notes)) : null;
  $("#view-body").replaceChildren(
    ...[
      field("Benutzername", e.username, { copyAs: "Benutzername" }),
      field("Passwort", e.password, { secret: true, mono: true, copyAs: "Passwort" }),
      field("Webseite", e.url, { link: safeUrl(e.url) }),
      field("Ordner", folderName(e.folder)),
      notes,
      e.history?.length ? field("Frühere Passwörter", `${e.history.length} gespeichert (zuletzt geändert ${fmt(e.history[0].changed)})`) : null,
      el("p", { class: "muted small" }, `Zuletzt geändert: ${fmt(e.updated)}`),
    ].filter(Boolean)
  );
  $("#dlg-view").showModal();
}

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

function openEdit(id) {
  const e = id ? vault.getEntry(id) : null;
  state.editing = id;
  $("#edit-heading").textContent = e ? "Eintrag bearbeiten" : "Neuer Eintrag";
  $("#edit-title").value = e?.title || "";
  $("#edit-username").value = e?.username || "";
  $("#edit-password").value = e?.password || "";
  $("#edit-password").type = "password";
  $("#edit-url").value = e?.url || "";
  $("#edit-notes").value = e?.notes || "";
  const preset = e ? e.folder : ["all", "none"].includes(state.folder) ? "" : state.folder;
  fillFolderSelect(preset);
  paintMeter($("#edit-meter"), $("#edit-password").value);
  $("#dlg-edit").showModal();
  if (!e) $("#edit-title").focus();
}

$("#edit-password").addEventListener("input", (e) => paintMeter($("#edit-meter"), e.target.value));
$("#edit-toggle").addEventListener("click", () => {
  const p = $("#edit-password");
  p.type = p.type === "password" ? "text" : "password";
});
$("#edit-gen").addEventListener("click", () => openGenerator($("#edit-password")));

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
  const fields = {
    title: $("#edit-title").value.trim(),
    username: $("#edit-username").value.trim(),
    password: $("#edit-password").value,
    url: $("#edit-url").value.trim(),
    notes: $("#edit-notes").value,
    folder: $("#edit-folder").value === NEW_FOLDER ? "" : $("#edit-folder").value,
  };
  if (state.editing) fields.id = state.editing;
  await vault.saveEntry(fields);
  $("#dlg-edit").close();
  renderAll();
  toast("Gespeichert");
});

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
  $("#dlg-settings").showModal();
}

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
      toast("Masterpasswort geändert – exportiere am besten neu");
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
