// Hintergrund: Auto-Sperre und Tastenkürzel zum direkten Ausfüllen.

import { hostOf, matchesHost, getSession, clearSession, scheduleLock, fillPage } from "./lib/shared.js";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lock") clearSession();
});

// Nach Installation/Update direkt die Einstellungsseite zeigen, falls noch keine Datei geladen ist.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { vault } = await chrome.storage.local.get("vault");
  if (reason === "install" && !vault) chrome.runtime.openOptionsPage();
});

async function openPopup() {
  try {
    await chrome.action.openPopup();
  } catch {
    // Ältere Browser: Popup lässt sich nicht per Code öffnen – dann über Strg+Shift+L.
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "fill-login" || !tab?.id) return;
  const session = await getSession();
  if (!session) return openPopup(); // gesperrt: zum Entsperren das Popup zeigen

  const tabHost = hostOf(tab.url);
  const matches = session.entries
    .filter((e) => e.type === "login" && matchesHost(e.url, tabHost))
    .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.lastUsed || 0) - (a.lastUsed || 0));

  // Genau ein passender Login: direkt ausfüllen. Sonst auswählen lassen.
  if (matches.length !== 1) return openPopup();
  await scheduleLock();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillPage, args: [matches[0].username || "", matches[0].password || ""] });
  } catch {
    // z. B. auf chrome://-Seiten nicht erlaubt
  }
});
