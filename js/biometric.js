// Entsperren mit Face ID / Touch ID / Windows Hello über einen Passkey (WebAuthn + PRF).
//
// Beim Einrichten legt das Gerät einen Passkey an. Die PRF-Erweiterung liefert dazu einen
// geheimen Wert, den das Gerät nur nach erfolgreicher Face-ID-Prüfung herausgibt. Daraus wird
// ein Schlüssel abgeleitet, mit dem das Masterpasswort verschlüsselt auf diesem Gerät liegt.
// Ohne Face ID ist dieser gespeicherte Wert nutzlos. Das Masterpasswort funktioniert immer weiter.

import { toB64, fromB64, randomBytes } from "./crypto.js";
import { getItem, setItem, removeItem } from "./storage.js";

const KEY = "bio";
const enc = new TextEncoder();

export class BioError extends Error {}

// Passender Name fürs Gerät, z. B. "Face ID" auf dem iPhone.
export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "Face ID";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "Face ID / Touch ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Windows/.test(ua)) return "Windows Hello";
  if (/Android/.test(ua)) return "Fingerabdruck";
  return "Gerätesperre";
}

export async function isSupported() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return false;
  try {
    if (PublicKeyCredential.getClientCapabilities) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps["extension:prf"] === false) return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export const isEnabled = async () => Boolean(await getItem(KEY));
export const disable = () => removeItem(KEY);

async function wrappingKey(prfOutput) {
  const base = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("tresor-bio-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function prfFirst(cred) {
  const out = cred.getClientExtensionResults().prf?.results?.first;
  return out ? new Uint8Array(out) : null;
}

async function evalPrf(credId, prfSalt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: credId }],
      userVerification: "required",
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const out = prfFirst(cred);
  if (!out) throw new BioError("unsupported");
  return out;
}

// Ein angelegter Passkey, dessen PRF-Wert noch fehlt (zweiter Versuch ohne neuen Passkey).
let pending = null;

// Richtet das Entsperren ein. checkPassword wird erst nach der Face-ID-Abfrage aufgerufen,
// weil Safari die Abfrage nur direkt nach einem Tippen erlaubt.
export async function enable(password, checkPassword) {
  let credId, prfSalt, out;
  if (pending) {
    ({ credId, prfSalt } = pending);
    out = await evalPrf(credId, prfSalt);
  } else {
    prfSalt = randomBytes(32);
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: "Tresor" },
        user: { id: randomBytes(16), name: "Tresor", displayName: `Tresor (${deviceLabel()})` },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const prf = cred.getClientExtensionResults().prf;
    if (!prf || (!prf.enabled && !prf.results)) throw new BioError("unsupported");
    credId = new Uint8Array(cred.rawId);
    out = prfFirst(cred);
    if (!out) {
      // Manche Geräte liefern den Wert erst bei der ersten Anmeldung.
      pending = { credId, prfSalt };
      try {
        out = await evalPrf(credId, prfSalt);
      } catch (err) {
        if (err.name === "NotAllowedError") throw new BioError("again");
        throw err;
      }
    }
  }
  pending = null;

  if (!(await checkPassword(password))) throw new BioError("wrong-password");

  const key = await wrappingKey(out);
  out.fill(0);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(password));
  await setItem(KEY, { credId: toB64(credId), prfSalt: toB64(prfSalt), iv: toB64(iv), data: toB64(new Uint8Array(ct)) });
}

// Fragt Face ID ab und gibt das gespeicherte Masterpasswort zurück.
export async function unlockPassword() {
  const b = await getItem(KEY);
  const out = await evalPrf(fromB64(b.credId), fromB64(b.prfSalt));
  const key = await wrappingKey(out);
  out.fill(0);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(b.iv) }, key, fromB64(b.data));
  return new TextDecoder().decode(pt);
}

// Verständliche Meldung für Fehler beim Einrichten oder Entsperren.
export function errorMessage(err) {
  const label = deviceLabel();
  if (err instanceof BioError) {
    return {
      unsupported: `${label} wird auf diesem Gerät oder in diesem Browser leider nicht unterstützt.`,
      again: `Fast geschafft – bitte noch einmal auf „Einrichten“ tippen.`,
      "wrong-password": "Das Masterpasswort ist falsch.",
    }[err.message];
  }
  if (err.name === "NotAllowedError") return `${label} wurde abgebrochen.`;
  if (err.name === "InvalidStateError") return "Für dieses Gerät gibt es schon einen Passkey. Bitte erneut versuchen.";
  return `${label} hat nicht geklappt (${err.name}).`;
}
