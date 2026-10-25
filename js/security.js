// Sicherheits-Check: findet schwache, mehrfach benutzte und alte Passwörter.

import { strength } from "./generator.js";

const OLD_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

// PINs und Notizen werden nicht bewertet (PINs sind absichtlich kurz).
const checkable = (e) => (e.type || "login") !== "note" && (e.type || "login") !== "pin" && e.password;

export function analyze(entries) {
  const list = entries.filter(checkable);
  const weak = list.filter((e) => strength(e.password).level <= 2);

  const byPw = new Map();
  for (const e of list) byPw.set(e.password, [...(byPw.get(e.password) || []), e]);
  const reused = [...byPw.values()].filter((g) => g.length > 1);

  const now = Date.now();
  const old = list.filter((e) => now - (e.pwChanged || e.created) > OLD_AFTER_MS);

  const flagged = new Set([...weak, ...reused.flat(), ...old].map((e) => e.id));
  return { total: list.length, ok: list.length - flagged.size, problems: flagged.size, weak, reused, old };
}
