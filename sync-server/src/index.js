// Tresor-Sync-Server (Cloudflare Worker + D1).
//
// Speichert pro Tresor genau einen verschlüsselten Blob. Der Server kann ihn nicht lesen:
// Entschlüsselt wird nur auf den Geräten mit dem Masterpasswort.
// Zugriff nur mit dem Sync-Token (aus dem Sync-Code abgeleitet); gespeichert wird davon nur ein Hash.
// Änderungen nutzen eine Versionsnummer, damit sich zwei Geräte nicht gegenseitig überschreiben.

const MAX_BYTES = 5 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*", // Schutz läuft über das Token, nicht über Cookies
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Vergleich in konstanter Zeit, damit sich das Token nicht durch Zeitmessung erraten lässt.
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json(200, { ok: true, service: "tresor-sync" });

    const match = url.pathname.match(/^\/v1\/vault\/([0-9a-f]{64})$/);
    if (!match) return json(404, { error: "not_found" });
    const id = match[1];

    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!/^[0-9a-f]{64}$/.test(token)) return json(401, { error: "unauthorized" });
    const authHash = await sha256Hex(token);

    const row = await env.DB.prepare("SELECT auth_hash, version, blob, updated FROM vaults WHERE id = ?").bind(id).first();
    if (row && !sameHex(row.auth_hash, authHash)) return json(401, { error: "unauthorized" });

    if (request.method === "GET") {
      if (!row) return json(404, { error: "empty" });
      return json(200, { version: row.version, updated: row.updated, blob: JSON.parse(row.blob) });
    }

    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json(413, { error: "too_large" });
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { error: "bad_json" });
      }
      const { expect, blob } = body || {};
      if (!Number.isInteger(expect) || blob?.format !== "tresor" || !blob.kdf || !blob.iv || !blob.data) {
        return json(400, { error: "bad_request" });
      }
      const now = Date.now();
      const blobText = JSON.stringify(blob);

      if (!row) {
        if (expect !== 0) return json(409, { error: "conflict", version: 0 });
        // INSERT OR IGNORE: Falls zwei Geräte gleichzeitig anlegen, gewinnt das erste.
        const res = await env.DB.prepare("INSERT OR IGNORE INTO vaults (id, auth_hash, version, blob, updated) VALUES (?, ?, 1, ?, ?)")
          .bind(id, authHash, blobText, now)
          .run();
        if (!res.meta.changes) return json(409, { error: "conflict" });
        return json(200, { version: 1, updated: now });
      }

      // Nur schreiben, wenn sich der Stand seit dem Lesen nicht geändert hat.
      const res = await env.DB.prepare("UPDATE vaults SET version = version + 1, blob = ?, updated = ? WHERE id = ? AND version = ?")
        .bind(blobText, now, id, expect)
        .run();
      if (!res.meta.changes) {
        const current = await env.DB.prepare("SELECT version, blob, updated FROM vaults WHERE id = ?").bind(id).first();
        return json(409, { error: "conflict", version: current.version, updated: current.updated, blob: JSON.parse(current.blob) });
      }
      return json(200, { version: expect + 1, updated: now });
    }

    if (request.method === "DELETE") {
      if (row) await env.DB.prepare("DELETE FROM vaults WHERE id = ?").bind(id).run();
      return json(200, { deleted: Boolean(row) });
    }

    return json(405, { error: "method_not_allowed" });
  },
};
