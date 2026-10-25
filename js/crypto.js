// Verschlüsselung: Schlüssel aus dem Masterpasswort (PBKDF2-SHA256), Tresor mit AES-256-GCM.
// Das Masterpasswort und der Schlüssel verlassen nie das Gerät.

const ITERATIONS = 600000; // OWASP-Empfehlung für PBKDF2-SHA256
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

export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Erzeugt neue KDF-Parameter (neues Salt) und den passenden Schlüssel.
export async function newKey(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return { key, kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt) } };
}

export async function keyFromKdf(password, kdf) {
  return deriveKey(password, fromB64(kdf.salt), kdf.iterations);
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
