// Automatischer Abgleich über den Sync-Server.
// Ablauf: Server-Stand holen → zusammenführen → wenn lokal Neueres da ist, hochladen.
// Die Versionsnummer verhindert, dass sich zwei Geräte gegenseitig überschreiben.

import * as vault from "./vault.js";
import { SYNC_URL } from "./config.js";
import { SyncError, syncRequest, fetchRemote as fetchRemoteFrom } from "./sync-core.js";

export { newCode, normalizeCode, formatCode, isValidCode, SyncError } from "./sync-core.js";

const request = (method, code, body) => syncRequest(SYNC_URL, method, code, body);
export const fetchRemote = (code) => fetchRemoteFrom(SYNC_URL, code);
export const deleteRemote = (code) => request("DELETE", code);

// ---------- Status ----------

// state: off | syncing | ok | offline | password | error
export const status = { state: "off", at: 0, message: "" };
const listeners = new Set();
export const onStatus = (fn) => listeners.add(fn);
let onRemoteChange = () => {};
export const setOnRemoteChange = (fn) => (onRemoteChange = fn);

function setStatus(state, message = "") {
  Object.assign(status, { state, message, at: state === "ok" ? Date.now() : status.at });
  for (const fn of listeners) fn(status);
}

// ---------- Abgleich ----------

let running = null;
let again = false;

// Startet einen Abgleich. Läuft schon einer, wird danach noch einmal abgeglichen.
export function syncNow(options = {}) {
  if (!vault.isUnlocked() || !vault.syncCode()) {
    setStatus("off");
    return Promise.resolve();
  }
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce(options);
        options = {};
      } while (again && vault.isUnlocked());
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce({ password, adopt } = {}) {
  const code = vault.syncCode();
  setStatus("syncing");
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await fetchRemote(code);
      let expect = 0;
      let ahead = true;
      if (remote) {
        expect = remote.version;
        const r = await vault.mergeRemote(remote.blob, { password, adopt });
        ahead = r.ahead;
        if (r.changed || r.keyChanged) onRemoteChange(r);
      }
      if (!ahead) return setStatus("ok");

      const res = await request("PUT", code, { expect, blob: await vault.exportBlob() });
      if (res.ok) return setStatus("ok");
      if (res.status !== 409) throw new SyncError(`Server-Fehler (${res.status}).`);
      // 409: Ein anderes Gerät war schneller – neu holen, zusammenführen, erneut versuchen.
    }
    throw new SyncError("Zu viele gleichzeitige Änderungen, versuche es gleich noch einmal.");
  } catch (err) {
    if (!vault.isUnlocked()) return setStatus("off");
    if (err instanceof vault.NeedPassword) return setStatus("password", "Das Masterpasswort wurde auf einem anderen Gerät geändert.");
    if (err instanceof SyncError) return setStatus("error", err.message);
    if (err instanceof TypeError || !navigator.onLine) return setStatus("offline", "Keine Verbindung – wird später abgeglichen.");
    // Entschlüsseln fehlgeschlagen
    if (password) return setStatus("password", "Das Passwort passt nicht zum Tresor auf dem Server.");
    return setStatus("error", "Die Daten auf dem Server sind nicht lesbar.");
  }
}

// Lädt den lokalen Stand hoch und ersetzt den Server-Stand (Notfall, z. B. bei beschädigten Daten).
export async function forceUpload() {
  const code = vault.syncCode();
  const remote = await fetchRemote(code);
  const res = await request("PUT", code, { expect: remote ? remote.version : 0, blob: await vault.exportBlob() });
  if (!res.ok) throw new SyncError(`Server-Fehler (${res.status}).`);
  setStatus("ok");
}
