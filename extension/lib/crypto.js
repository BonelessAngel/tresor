// Verschlüsselung: Schlüssel aus dem Masterpasswort (Argon2id), Tresor mit AES-256-GCM.
// Das Masterpasswort und der Schlüssel verlassen nie das Gerät.
// Ältere Tresore mit PBKDF2-SHA256 lassen sich weiter öffnen und werden beim Entsperren umgestellt.

import "./vendor/argon2.umd.min.js"; // hash-wasm (MIT), stellt globalThis.hashwasm bereit

const ITERATIONS = 600000; // PBKDF2 (nur noch für alte Tresore)
// Argon2id: 64 MiB Speicher, 3 Durchläufe – OWASP-Empfehlung, auf dem iPhone ca. 1 s.
const ARGON2 = { name: "Argon2id", memory: 65536, iterations: 3, parallelism: 1 };
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function pbkdf2Key(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function argon2Key(password, salt, { memory, iterations, parallelism }) {
  const raw = await globalThis.hashwasm.argon2id({
    password,
    salt,
    memorySize: memory,
    iterations,
    parallelism,
    hashLength: 32,
    outputType: "binary",
  });
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

// Erzeugt neue KDF-Parameter (neues Salt) und den passenden Schlüssel.
export async function newKey(password) {
  const salt = randomBytes(16);
  const key = await argon2Key(password, salt, ARGON2);
  return { key, kdf: { ...ARGON2, salt: toB64(salt) } };
}

export async function keyFromKdf(password, kdf) {
  const salt = fromB64(kdf.salt);
  if (kdf.name === "Argon2id") return argon2Key(password, salt, kdf);
  if (kdf.name === "PBKDF2-SHA256") return pbkdf2Key(password, salt, kdf.iterations);
  throw new Error("Unbekanntes Verfahren: " + kdf.name);
}

// true, wenn der Tresor noch ein älteres/schwächeres Verfahren nutzt.
export function needsUpgrade(kdf) {
  return kdf.name !== ARGON2.name || kdf.memory < ARGON2.memory || kdf.iterations < ARGON2.iterations;
}

export async function encryptJson(key, kdf, data) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { format: "tresor", version: 1, kdf, iv: toB64(iv), data: toB64(new Uint8Array(ct)) };
}

// Wirft einen Fehler bei falschem Passwort oder manipulierten Daten.
export async function decryptJson(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.data));
  return JSON.parse(dec.decode(pt));
}
