// Tresor-Logik: anlegen, entsperren, speichern, Einträge/Ordner, Export und Import.
// Gelöschte Einträge bleiben als "Grabstein" (deleted: true) erhalten, damit das
// Zusammenführen zwischen Geräten Löschungen korrekt übernimmt.

import { newKey, keyFromKdf, encryptJson, decryptJson, needsUpgrade } from "./crypto.js";
import { loadBlob, saveBlob } from "./storage.js";

let key = null;
let kdf = null;
let data = null;
let onChange = null;

// Wird nach jeder inhaltlichen Änderung aufgerufen (z. B. um den Sync anzustoßen).
export const setOnChange = (fn) => (onChange = fn);

const now = () => Date.now();
const uid = () => crypto.randomUUID();

export const isUnlocked = () => key !== null;
export const hasVault = async () => Boolean(await loadBlob());

export async function create(password) {
  ({ key, kdf } = await newKey(password));
  data = { entries: [], folders: [] };
  await persist();
}

export async function unlock(password) {
  const blob = await loadBlob();
  const k = await keyFromKdf(password, blob.kdf);
  data = await decryptJson(k, blob); // wirft bei falschem Passwort
  key = k;
  kdf = blob.kdf;
  await purgeExpiredTrash();
  return upgradeIfNeeded(password);
}

// Stellt alte Tresore (PBKDF2) automatisch auf Argon2id um. Gibt true zurück, wenn umgestellt.
async function upgradeIfNeeded(password) {
  if (!needsUpgrade(kdf)) return false;
  ({ key, kdf } = await newKey(password));
  await persist();
  return true;
}

export function lock() {
  key = null;
  kdf = null;
  data = null;
}

async function persist({ silent = false } = {}) {
  await saveBlob(await encryptJson(key, kdf, data));
  if (!silent) onChange?.();
}

export async function checkPassword(password) {
  const blob = await loadBlob();
  try {
    await decryptJson(await keyFromKdf(password, blob.kdf), blob);
    return true;
  } catch {
    return false;
  }
}

export async function changePassword(oldPassword, newPassword) {
  const blob = await loadBlob();
  await decryptJson(await keyFromKdf(oldPassword, blob.kdf), blob); // prüft altes Passwort
  ({ key, kdf } = await newKey(newPassword));
  await persist();
}

// ---- Einträge ----

export function entries() {
  return data.entries.filter((e) => !e.deleted).sort((a, b) => a.title.localeCompare(b.title, "de"));
}

export const getEntry = (id) => data.entries.find((e) => e.id === id && !e.deleted);

export async function saveEntry(fields) {
  const t = now();
  const existing = fields.id && data.entries.find((e) => e.id === fields.id);
  if (existing) {
    if (existing.password !== fields.password) {
      if (existing.password) {
        existing.history = [{ password: existing.password, changed: t }, ...(existing.history || [])].slice(0, 10);
      }
      existing.pwChanged = t;
    }
    Object.assign(existing, fields, { updated: t });
  } else {
    data.entries.push({ ...fields, id: uid(), created: t, updated: t, pwChanged: t });
  }
  await persist();
}

export async function toggleFavorite(id) {
  const e = getEntry(id);
  if (!e) return;
  Object.assign(e, { favorite: !e.favorite, updated: now() });
  await persist();
  return e.favorite;
}

// Merkt sich die letzte Nutzung, ohne "zuletzt geändert" zu verschieben.
export async function markUsed(id) {
  const e = getEntry(id);
  if (!e) return;
  e.lastUsed = now();
  await persist({ silent: true }); // nur fürs Sortieren auf diesem Gerät, kein Sync nötig
}

// ---- Papierkorb ----
// Gelöschte Einträge behalten 30 Tage lang ihre Daten und lassen sich wiederherstellen.
// Danach bleibt nur der Grabstein übrig (für das Zusammenführen zwischen Geräten).

const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

const tombstone = (id) => ({ id, deleted: true, updated: now() });

export async function deleteEntry(id) {
  const e = getEntry(id);
  if (!e) return;
  const t = now();
  Object.assign(e, { deleted: true, deletedAt: t, updated: t });
  await persist();
}

// Einträge im Papierkorb (nur solche, die noch Daten haben), neueste zuerst.
export function trash() {
  return data.entries.filter((e) => e.deleted && e.title).sort((a, b) => b.deletedAt - a.deletedAt);
}

export const trashDaysLeft = (e) => Math.max(0, Math.ceil((e.deletedAt + TRASH_MS - now()) / 86400000));

export async function restoreEntry(id) {
  const e = data.entries.find((x) => x.id === id && x.deleted && x.title);
  if (!e) return;
  delete e.deletedAt;
  Object.assign(e, { deleted: false, updated: now() });
  if (e.folder && !folders().some((f) => f.id === e.folder)) e.folder = "";
  await persist();
}

export async function purgeEntry(id) {
  const i = data.entries.findIndex((e) => e.id === id && e.deleted);
  if (i >= 0) data.entries[i] = tombstone(id);
  await persist();
}

export async function emptyTrash() {
  data.entries = data.entries.map((e) => (e.deleted && e.title ? tombstone(e.id) : e));
  await persist();
}

// Wird beim Entsperren aufgerufen: räumt Einträge auf, die länger als 30 Tage im Papierkorb liegen.
async function purgeExpiredTrash() {
  let changed = false;
  data.entries = data.entries.map((e) => {
    if (e.deleted && e.title && now() - (e.deletedAt || e.updated) > TRASH_MS) {
      changed = true;
      return { id: e.id, deleted: true, updated: e.updated };
    }
    return e;
  });
  if (changed) await persist();
}

// ---- Ordner ----

export function folders() {
  return data.folders.filter((f) => !f.deleted).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export async function addFolder(name) {
  const f = { id: uid(), name, updated: now() };
  data.folders.push(f);
  await persist();
  return f;
}

export async function renameFolder(id, name) {
  const f = data.folders.find((x) => x.id === id);
  if (f) Object.assign(f, { name, updated: now() });
  await persist();
}

export async function deleteFolder(id) {
  const t = now();
  const f = data.folders.find((x) => x.id === id);
  if (f) Object.assign(f, { deleted: true, updated: t });
  for (const e of data.entries) {
    if (e.folder === id && !e.deleted) Object.assign(e, { folder: "", updated: t });
  }
  await persist();
}

// ---- Export / Import ----

// Die Exportdatei ist genauso verschlüsselt wie der Tresor selbst.
export const exportBlob = () => loadBlob();

function mergeList(mine, theirs) {
  const byId = new Map(mine.map((x) => [x.id, x]));
  let changed = 0;
  for (const t of theirs) {
    const m = byId.get(t.id);
    if (!m || t.updated > m.updated) {
      byId.set(t.id, t);
      changed++;
    }
  }
  return { list: [...byId.values()], changed };
}

// Führt eine Exportdatei (auch von einem anderen Gerät) mit dem Tresor zusammen.
// Pro Eintrag gewinnt die neuere Version.
export async function importBlob(blob, password) {
  if (blob?.format !== "tresor") throw new Error("Keine gültige Tresor-Datei.");
  const other = await decryptJson(await keyFromKdf(password, blob.kdf), blob);
  const e = mergeList(data.entries, other.entries || []);
  const f = mergeList(data.folders, other.folders || []);
  data.entries = e.list;
  data.folders = f.list;
  await persist();
  return e.changed + f.changed;
}

// ---- Sync ----

export const syncCode = () => data?.sync?.code || null;

export async function setSyncCode(code) {
  if (code) data.sync = { code };
  else delete data.sync;
  await persist({ silent: true });
}

export class NeedPassword extends Error {}

const sameKdf = (a, b) =>
  Boolean(a && b) && a.name === b.name && a.salt === b.salt && a.iterations === b.iterations && a.memory === b.memory;

// Führt den Stand vom Server ein. Normalerweise nutzen alle Geräte denselben Schlüssel, dann
// geht das ohne Passwort. Wurde das Masterpasswort irgendwo geändert, wird es einmal gebraucht
// (NeedPassword); der neuere Schlüssel gewinnt, beim Koppeln (adopt) immer der vom Server.
// Ergebnis: changed = lokal hat sich etwas geändert, ahead = lokal ist Neueres -> hochladen.
export async function mergeRemote(blob, { password, adopt = false } = {}) {
  if (!key) throw new Error("locked");
  let other;
  let remoteKey = null;
  if (sameKdf(blob.kdf, kdf)) {
    other = await decryptJson(key, blob);
  } else {
    if (!password) throw new NeedPassword();
    remoteKey = await keyFromKdf(password, blob.kdf);
    other = await decryptJson(remoteKey, blob); // wirft bei falschem Passwort
  }
  const theirEntries = other.entries || [];
  const theirFolders = other.folders || [];
  const ahead = mergeList(theirEntries, data.entries).changed + mergeList(theirFolders, data.folders).changed;
  const e = mergeList(data.entries, theirEntries);
  const f = mergeList(data.folders, theirFolders);
  data.entries = e.list;
  data.folders = f.list;

  let keyChanged = false;
  if (remoteKey && (adopt || (blob.kdf.changed || 0) > (kdf.changed || 0))) {
    key = remoteKey;
    kdf = blob.kdf;
    keyChanged = true;
  }
  const changed = e.changed + f.changed;
  if (changed || keyChanged) await persist({ silent: true });
  return { changed, keyChanged, ahead: ahead > 0 || !sameKdf(blob.kdf, kdf) };
}

// Für Erst-Import auf einem neuen Gerät: Datei wird direkt zum Tresor.
export async function adoptBlob(blob, password) {
  if (blob?.format !== "tresor") throw new Error("Keine gültige Tresor-Datei.");
  const k = await keyFromKdf(password, blob.kdf);
  data = await decryptJson(k, blob);
  key = k;
  kdf = blob.kdf;
  await saveBlob(blob);
  await purgeExpiredTrash();
  return upgradeIfNeeded(password);
}
