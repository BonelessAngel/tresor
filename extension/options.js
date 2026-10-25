// Einstellungsseite: Tresor-Datei laden, Auto-Sperre, Entfernen.

import { clearSession, autolockMinutes, scheduleLock, getSession } from "./lib/shared.js";

const $ = (sel) => document.querySelector(sel);

async function renderStatus() {
  const { vault } = await chrome.storage.local.get("vault");
  $("#status").textContent = vault
    ? `Geladen: „${vault.fileName}“ am ${new Date(vault.importedAt).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}.`
    : "Noch keine Tresor-Datei geladen.";
  $("#btn-import").textContent = vault ? "Neuere Tresor-Datei laden …" : "Tresor-Datei laden …";
  $("#btn-remove").disabled = !vault;
}

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
  await chrome.storage.local.remove("vault");
  await clearSession();
  renderStatus();
});

$("#autolock").value = String(await autolockMinutes());
renderStatus();
