-- Ein verschlüsselter Tresor pro Sync-Code.
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,        -- aus dem Sync-Code abgeleitet (SHA-256, hex)
  auth_hash TEXT NOT NULL,    -- SHA-256 des Sync-Tokens; das Token selbst wird nie gespeichert
  version INTEGER NOT NULL,   -- steigt bei jedem Speichern, verhindert gegenseitiges Überschreiben
  blob TEXT NOT NULL,         -- verschlüsselter Tresor (für den Server unlesbar)
  updated INTEGER NOT NULL    -- Zeitpunkt der letzten Änderung (ms)
);
