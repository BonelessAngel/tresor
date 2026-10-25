// Popup: entsperren, passende Logins anzeigen, ausfüllen oder kopieren.

import { keyFromKdf, decryptJson } from "./lib/crypto.js";
import { hostOf, matchesHost, getSession, setSession, clearSession, scheduleLock, fillPage } from "./lib/shared.js";

const $ = (sel) => document.querySelector(sel);
const state = { tab: null, tabHost: "", entries: [], visible: [], sel: 0 };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(msg) {
  $("#toast").textContent = msg;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2000);
}

function show(view) {
  for (const v of ["empty", "locked", "list"]) $("#view-" + v).hidden = v !== view;
  $("#btn-lock").hidden = view !== "list";
}

// ---------- Start ----------

async function init() {
  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabHost = hostOf(state.tab?.url);

  const { vault } = await chrome.storage.local.get("vault");
  if (!vault) return show("empty");

  const session = await getSession();
  if (!session) {
    show("locked");
    $("#unlock-pw").focus();
    return;
  }
  await scheduleLock(); // Benutzung verlängert die Auto-Sperre
  state.entries = session.entries;
  showList();
}

$("#btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#btn-setup").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#btn-lock").addEventListener("click", async () => {
  await clearSession();
  state.entries = [];
  $("#list").replaceChildren();
  show("locked");
  $("#unlock-pw").focus();
});

// ---------- Entsperren ----------

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("#unlock-btn");
  $("#unlock-error").textContent = "";
  button.disabled = true;
  button.textContent = "Entsperre …";
  try {
    const { vault } = await chrome.storage.local.get("vault");
    const data = await decryptJson(await keyFromKdf($("#unlock-pw").value, vault.blob.kdf), vault.blob);
    // Nur was zum Ausfüllen und Kopieren nötig ist, kommt in den Arbeitsspeicher.
    state.entries = (data.entries || [])
      .filter((x) => !x.deleted && (x.type || "login") !== "note")
      .map(({ id, title, username, password, url, type, favorite, lastUsed }) => ({ id, title, username, password, url, type: type || "login", favorite, lastUsed }));
    await setSession(state.entries);
    $("#unlock-pw").value = "";
    showList();
  } catch {
    $("#unlock-error").textContent = "Falsches Masterpasswort.";
    $("#unlock-pw").select();
  } finally {
    button.disabled = false;
    button.textContent = "Entsperren";
  }
});

// ---------- Liste ----------

function showList() {
  show("list");
  render();
  $("#search").focus();
}

$("#search").addEventListener("input", () => {
  state.sel = 0;
  render();
});

const byUse = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.lastUsed || 0) - (a.lastUsed || 0) || a.title.localeCompare(b.title, "de");

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const isMatch = (e) => e.type === "login" && matchesHost(e.url, state.tabHost);
  let groups;
  if (q) {
    const hits = state.entries.filter((e) => [e.title, e.username, e.url].some((v) => v?.toLowerCase().includes(q))).sort(byUse);
    groups = [["Suchergebnisse", hits]];
  } else {
    const matching = state.entries.filter(isMatch).sort(byUse);
    const favs = state.entries.filter((e) => e.favorite && !isMatch(e)).sort(byUse);
    groups = [
      [state.tabHost ? `Passend für ${state.tabHost}` : "Passend für diese Seite", matching],
      ["Favoriten", favs],
    ];
  }

  state.visible = groups.flatMap(([, list]) => list);
  state.sel = Math.min(state.sel, Math.max(state.visible.length - 1, 0));
  let i = 0;
  const nodes = [];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    nodes.push(el("div", { class: "group" }, title));
    for (const e of list) nodes.push(itemNode(e, i++, isMatch(e)));
  }
  if (!state.visible.length) {
    nodes.push(el("p", { class: "empty" }, q ? "Keine Treffer." : "Kein Login für diese Seite gespeichert. Tippe oben, um zu suchen."));
  }
  $("#list").replaceChildren(...nodes);
}

function itemNode(e, index, matching) {
  const canFill = e.type === "login" && state.tab?.id && /^https?:/.test(state.tab.url || "");
  return el("div", { class: "item" + (index === state.sel ? " selected" : "") },
    el("button", { class: "item-main", title: canFill ? "Ausfüllen" : "Passwort kopieren", onclick: () => (canFill ? fill(e, matching) : copy(e.password, "Passwort")) },
      el("div", { class: "item-title" }, e.title + (e.favorite ? " ★" : "")),
      el("div", { class: "item-sub" }, e.username || hostOf(e.url) || (e.type === "wifi" ? "WLAN" : e.type === "pin" ? "PIN" : ""))
    ),
    e.username ? el("button", { class: "icon-btn", title: "Benutzername kopieren", "aria-label": "Benutzername kopieren", onclick: () => copy(e.username, "Benutzername") }, "👤") : null,
    e.password ? el("button", { class: "icon-btn", title: "Passwort kopieren", "aria-label": "Passwort kopieren", onclick: () => copy(e.password, "Passwort") }, "🔑") : null,
    canFill ? el("button", { class: "btn primary fill-btn", onclick: () => fill(e, matching) }, "Ausfüllen") : null
  );
}

// ---------- Aktionen ----------

async function copy(text, what) {
  if (!text) return toast(`${what} ist leer`);
  await navigator.clipboard.writeText(text);
  toast(`${what} kopiert`);
}

async function fill(e, matching) {
  // Schutz vor Phishing: auf fremden Seiten nur nach Rückfrage ausfüllen.
  if (!matching) {
    const where = hostOf(e.url) || "keine Webseite gespeichert";
    if (!confirm(`Achtung: Diese Seite ist ${state.tabHost || "unbekannt"}, der Eintrag gehört zu ${where}.\n\nTrotzdem ausfüllen?`)) return;
  }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func: fillPage, args: [e.username || "", e.password || ""] });
    const r = res?.result;
    if (!r || (!r.user && !r.password)) return toast("Kein Login-Feld gefunden");
    window.close();
  } catch {
    toast("Auf dieser Seite darf nicht ausgefüllt werden");
  }
}

// ---------- Tastatur ----------

document.addEventListener("keydown", (e) => {
  if ($("#view-list").hidden) return;
  const entry = state.visible[state.sel];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!state.visible.length) return;
    state.sel = (state.sel + (e.key === "ArrowDown" ? 1 : -1) + state.visible.length) % state.visible.length;
    render();
    $("#list .selected")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && entry) {
    e.preventDefault();
    if (entry.type === "login") fill(entry, matchesHost(entry.url, state.tabHost));
    else copy(entry.password, "Passwort");
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && entry && !window.getSelection().toString()) {
    e.preventDefault();
    copy(entry.password, "Passwort");
  }
});

init();
