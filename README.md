# Tresor – mein Passwort-Manager

Eine Web-App (PWA), die auf dem PC und auf dem iPhone läuft. Alles bleibt **verschlüsselt auf dem Gerät**. Es gibt keinen Server, der deine Passwörter sieht.

## Sicherheit

- Aus dem Masterpasswort wird mit **Argon2id** (64 MiB, 3 Durchläufe) ein Schlüssel abgeleitet. Ältere Tresore mit PBKDF2 werden beim Entsperren automatisch umgestellt.
- Der Tresor ist mit **AES-256-GCM** verschlüsselt (WebCrypto des Browsers, keine fremden Bibliotheken).
- Gespeichert wird nur der verschlüsselte Blob in IndexedDB.
- Die App sperrt sich automatisch nach Inaktivität (einstellbar) und wenn sie länger im Hintergrund war.
- Kopierte Passwörter werden nach 30 Sekunden aus der Zwischenablage überschrieben, soweit der Browser das erlaubt.
- Eine strenge Content-Security-Policy verhindert fremde Skripte.
- **Masterpasswort vergessen = Daten weg.** Es gibt bewusst keine Hintertür.

## Bedienung

- **Eintragsarten:** Login, WLAN, PIN (🎲 erzeugt eine 6-stellige PIN), Notiz
- **⭐ Favoriten** stehen immer oben. Danach wird nach „zuletzt benutzt“ oder A–Z sortiert.
- **🌐** kopiert das Passwort und öffnet gleichzeitig die Webseite.
- **🛡 Sicherheits-Check:** zeigt schwache, mehrfach benutzte und über ein Jahr alte Passwörter.

### Tastatur (PC)

| Taste | Aktion |
|---|---|
| `/` oder `Strg+K` | Suche |
| `↑` `↓` | Eintrag auswählen |
| `Enter` | Passwort kopieren |
| `Shift+Enter` | Benutzername kopieren |
| `Strg+Enter` | Webseite öffnen + Passwort kopieren |
| `Esc` | Suche leeren |

## Lokal starten (PC)

```bash
node serve.js
```

Danach http://localhost:8080 öffnen.

## Geräte abgleichen

Einstellungen → **Exportieren** erzeugt eine `.tresor`-Datei, die mit dem Masterpasswort verschlüsselt ist. Auf dem anderen Gerät öffnest du **Importieren**. Die Einträge werden zusammengeführt, pro Eintrag gewinnt die neuere Änderung, und Löschungen werden mit übernommen.

Auf einem neuen Gerät nimmst du beim ersten Start „Vorhandene Tresor-Datei laden“.

Die Datei kannst du z. B. per OneDrive, iCloud Drive oder USB übertragen. Sie ist ohne Masterpasswort nutzlos.

## iPhone

Das iPhone braucht die App über **https** (z. B. kostenlos über GitHub Pages). Dann:

1. Seite in **Safari** öffnen
2. Teilen → **Zum Home-Bildschirm**
3. Ab jetzt immer über das Icon starten

Wichtig: Nutze sie immer über das Home-Bildschirm-Icon. Normale Safari-Tabs können Website-Daten nach einiger Zeit ohne Nutzung löschen. Trotzdem gilt: **regelmäßig exportieren** (Backup).

## Dateien

| Datei | Zweck |
|---|---|
| `js/crypto.js` | Schlüsselableitung, Ver-/Entschlüsselung |
| `js/storage.js` | IndexedDB |
| `js/vault.js` | Einträge, Ordner, Export/Import, Zusammenführen |
| `js/generator.js` | Passwort-Generator, Stärke-Anzeige |
| `js/security.js` | Sicherheits-Check |
| `js/vendor/argon2.umd.min.js` | Argon2id aus [hash-wasm](https://www.npmjs.com/package/hash-wasm) 4.12.0 (MIT) |
| `js/app.js` | Oberfläche |
| `sw.js` | Offline-Modus (speichert nur App-Dateien) |

Nach Änderungen an App-Dateien in `sw.js` die Versionsnummer `CACHE` hochzählen, damit Geräte das Update laden.
