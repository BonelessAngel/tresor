// Gemeinsame Hilfen für Popup und Hintergrund-Skript der Erweiterung.

const DEFAULT_AUTOLOCK_MIN = 15;

export function hostOf(url) {
  if (!url) return "";
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
}

// Passt ein gespeicherter Login zur Seite? Auch Subdomains zählen
// (z. B. Eintrag "amazon.de" passt zu "login.amazon.de" und umgekehrt).
export function matchesHost(entryUrl, tabHost) {
  const host = hostOf(entryUrl);
  if (!host || !tabHost) return false;
  return host === tabHost || tabHost.endsWith("." + host) || host.endsWith("." + tabHost);
}

// Entsperrte Einträge liegen nur im Arbeitsspeicher des Browsers (storage.session),
// nie auf der Festplatte, und verschwinden beim Sperren oder Schließen des Browsers.
export async function getSession() {
  const { session } = await chrome.storage.session.get("session");
  return session || null;
}

export async function setSession(entries) {
  await chrome.storage.session.set({ session: { entries, unlockedAt: Date.now() } });
  await scheduleLock();
}

export async function clearSession() {
  await chrome.storage.session.remove("session");
  await chrome.alarms.clear("lock");
}

export async function autolockMinutes() {
  const { autolock } = await chrome.storage.local.get("autolock");
  return autolock || DEFAULT_AUTOLOCK_MIN;
}

export async function scheduleLock() {
  await chrome.alarms.create("lock", { delayInMinutes: await autolockMinutes() });
}

// Wird in die Webseite eingeschleust: füllt Benutzername und Passwort aus.
// Muss eigenständig sein (keine Variablen von außen), weil Chrome nur den Funktionstext überträgt.
export function fillPage(username, password) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled && !el.readOnly;
  };
  const setValue = (el, value) => {
    // Über den nativen Setter, damit auch React/Vue-Seiten die Eingabe mitbekommen.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const pw = inputs.find((i) => i.type === "password");
  const userTypes = ["text", "email", "tel", ""];
  const isUser = (i) =>
    userTypes.includes(i.type) &&
    (/user|mail|login|name|konto|kennung|account|id/i.test(i.name + i.id + i.autocomplete + i.placeholder) || i.type === "email");

  let user = null;
  if (pw) {
    // Das Benutzerfeld steht meist direkt vor dem Passwortfeld im selben Formular.
    const scope = pw.form ? [...pw.form.querySelectorAll("input")].filter(visible) : inputs;
    const before = scope.slice(0, scope.indexOf(pw)).filter((i) => userTypes.includes(i.type));
    user = before.reverse().find(isUser) || before[0] || null;
  } else {
    // Mehrstufige Logins (erst E-Mail, dann Passwort auf der nächsten Seite).
    user = inputs.find(isUser) || null;
  }

  if (user && username) setValue(user, username);
  if (pw && password) setValue(pw, password);
  if (pw) pw.focus();
  return { user: Boolean(user && username), password: Boolean(pw && password) };
}
