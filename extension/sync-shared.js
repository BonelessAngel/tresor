// Kopiert die gemeinsam genutzten Dateien der Web-App in die Erweiterung.
// Nach Änderungen an js/crypto.js einmal ausführen:  node extension/sync-shared.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = ["js/crypto.js", "js/sync-core.js", "js/vendor/argon2.umd.min.js", "js/vendor/hash-wasm-LICENSE.txt"];

for (const f of files) {
  const target = path.join(__dirname, "lib", path.relative("js", f));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, f), target);
  console.log("kopiert:", f, "->", path.relative(root, target));
}
