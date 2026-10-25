// Speichert den verschlüsselten Tresor in IndexedDB (bleibt auf dem Gerät).

const DB_NAME = "tresor";
const STORE = "kv";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export const getItem = (key) => run("readonly", (s) => s.get(key));
export const setItem = (key, value) => run("readwrite", (s) => s.put(value, key));
export const removeItem = (key) => run("readwrite", (s) => s.delete(key));

export const loadBlob = () => getItem("vault");
export const saveBlob = (blob) => setItem("vault", blob);
export const deleteBlob = () => removeItem("vault");

// Bittet den Browser, die Daten nicht automatisch zu löschen (wichtig auf dem iPhone).
export async function requestPersist() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
