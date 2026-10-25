// Passwort-Generator mit kryptografisch sicherem Zufall.

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%&*?-_=+.:;",
};
const AMBIGUOUS = { lower: "l", upper: "IO", digits: "01" };

// Gleichverteilte Zufallszahl in [0, max) ohne Modulo-Verzerrung.
function randInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export function generate({ length = 20, lower = true, upper = true, digits = true, symbols = true, ambiguous = false } = {}) {
  const active = Object.entries({ lower, upper, digits, symbols })
    .filter(([, on]) => on)
    .map(([name]) => SETS[name] + (ambiguous ? AMBIGUOUS[name] || "" : ""));
  if (!active.length) return "";

  // Aus jeder gewählten Gruppe mindestens ein Zeichen, Rest aus allen, dann mischen.
  const all = active.join("");
  const chars = active.map((set) => set[randInt(set.length)]);
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join("");
}

// Grobe Stärke-Schätzung in Bit (Zeichenvielfalt × Länge).
export function strength(pw) {
  if (!pw) return { bits: 0, label: "", level: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 30;
  const bits = Math.round(pw.length * Math.log2(pool || 1));
  const level = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, level, label: ["", "schwach", "mittel", "gut", "sehr stark"][level] };
}
