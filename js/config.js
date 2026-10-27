// Adresse des Sync-Servers. Beim lokalen Testen läuft er über "wrangler dev".
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);

export const SYNC_URL = LOCAL ? "http://127.0.0.1:8787" : "https://tresor-sync.REPLACE_ME.workers.dev";

// Öffentliche Adresse der App (für den Kopplungs-Link im QR-Code).
export const APP_URL = LOCAL ? location.origin + location.pathname : "https://bonelessangel.github.io/tresor/";
