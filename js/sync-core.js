// Gemeinsame Sync-Bausteine für App und Erweiterung (ohne Zugriff auf den Tresor selbst).
//
// Alle Geräte teilen einen Sync-Code (32 Zeichen). Daraus werden die Tresor-ID und das
// Zugangs-Token für den Server abgeleitet. Der Server bekommt nur den verschlüsselten Tresor.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne I, O, 0, 1 (verwechselbar)

export class SyncError extends Error {}

// Neuer Sync-Code: 160 Bit Zufall, z. B. "K7QM-2XHD-…".
export function newCode() {
  let out = "";
  let val = 0;
  let bits = 0;
  for (const byte of crypto.getRandomValues(new Uint8Array(20))) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(val >> (bits - 5)) & 31];
      bits -= 5;
    }
    val &= (1 << bits) - 1;
  }
  return formatCode(out);
}

export const normalizeCode = (code) => (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code) => normalizeCode(code).match(/.{1,4}/g)?.join("-") || "";
export const isValidCode = (code) => new RegExp(`^[${ALPHABET}]{32}$`).test(normalizeCode(code));

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function syncRequest(baseUrl, method, code, body) {
  const n = normalizeCode(code);
  const id = await sha256Hex("tresor-sync-id:" + n);
  const token = await sha256Hex("tresor-sync-auth:" + n);
  return fetch(`${baseUrl}/v1/vault/${id}`, {
    method,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
}

// Holt den Server-Stand: { version, blob } oder null, wenn dort noch nichts liegt.
export async function fetchRemote(baseUrl, code) {
  const res = await syncRequest(baseUrl, "GET", code);
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(res.status === 401 ? "Der Sync-Code ist ungültig." : `Server-Fehler (${res.status}).`);
  return res.json();
}
