// Einstellungsseite: Tresor-Datei laden, Auto-Sperre, Entfernen.

import { clearSession, autolockMinutes, scheduleLock, getSession, fetchSyncedVault } from "./lib/shared.js";
import { isValidCode, formatCode } from "./lib/sync-core.js";

const $ = (sel) => document.querySelector(sel);

async function renderStatus() {
  const { vault, syncCode } = await chrome.storage.local.get(["vault", "syncCode"]);
  $("#sync-off").hidden = Boolean(syncCode);
  $("#sync-on").hidden = !syncCode;
  $("#file-card").hidden = Boolean(syncCode); // mit Sync ist das Datei-Laden überflüssig
  $("#status").textContent = vault
    ? `Geladen: „${vault.fileName}“ am ${new Date(vault.importedAt).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}.`
    : "Noch keine Tresor-Datei geladen.";
  $("#btn-import").textContent = vault ? "Neuere Tresor-Datei laden …" : "Tresor-Datei laden …";
  $("#btn-remove").disabled = !vault;
}

$("#sync-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#sync-error").textContent = "";
  const code = $("#sync-code").value;
  if (!isValidCode(code)) {
    $("#sync-error").textContent = "Der Code hat nicht das richtige Format (32 Zeichen).";
    return;
  }
  let remote;
  try {
    remote = await fetchSyncedVault(code);
  } catch (err) {
    $("#sync-error").textContent = err.message || "Server nicht erreichbar.";
    return;
  }
  if (!remote) {
    $("#sync-error").textContent = "Zu diesem Code gibt es noch keinen Tresor. Ist Sync in der App eingeschaltet?";
    return;
  }
  await chrome.storage.local.set({
    syncCode: formatCode(code),
    vault: { blob: remote.blob, version: remote.version, fileName: "Sync", importedAt: Date.now() },
  });
  await clearSession();
  $("#sync-code").value = "";
  $("#import-ok").textContent = "";
  renderStatus();
});

$("#btn-sync-off").addEventListener("click", async () => {
  if (!confirm("Sync trennen? Die Erweiterung behält den letzten Stand, aktualisiert sich aber nicht mehr.")) return;
  await chrome.storage.local.remove("syncCode");
  renderStatus();
});

$("#btn-import").addEventListener("click", () => $("#file").click());

$("#file").addEventListener("change", async () => {
  const file = $("#file").files[0];
  $("#import-error").textContent = $("#import-ok").textContent = "";
  if (!file) return;
  let blob;
  try {
    blob = JSON.parse(await file.text());
  } catch {
    $("#import-error").textContent = "Die Datei konnte nicht gelesen werden.";
    return;
  }
  if (blob?.format !== "tresor" || !blob.kdf || !blob.iv || !blob.data) {
    $("#import-error").textContent = "Das ist keine Tresor-Datei. Exportiere sie in der App unter ⚙️ → Exportieren.";
    return;
  }
  await chrome.storage.local.set({ vault: { blob, fileName: file.name, importedAt: Date.now() } });
  await clearSession(); // beim nächsten Öffnen mit der neuen Datei entsperren
  $("#file").value = "";
  $("#import-ok").textContent = "✅ Geladen. Klick oben in der Leiste auf das Tresor-Symbol und entsperre mit deinem Masterpasswort.";
  renderStatus();
});

$("#autolock").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ autolock: Number(e.target.value) });
  if (await getSession()) await scheduleLock();
});

$("#btn-remove").addEventListener("click", async () => {
  if (!confirm("Die Tresor-Kopie aus der Erweiterung entfernen?")) return;
  await chrome.storage.local.remove(["vault", "syncCode"]);
  await clearSession();
  renderStatus();
});

$("#autolock").value = String(await autolockMinutes());
renderStatus();
