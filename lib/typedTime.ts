// A time typed the way people say it: "10:30 PM", "1030p", "10p", "22:30",
// "2230". An hour of 1-12 with no AM or PM isn't a time yet ("1130" could
// be either): it's never guessed. Null until it reads as a whole time.

export function parseTypedTime(text: string): { h: number; m: number } | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, "").replace(".", ":");
  const x = /^(\d{1,4})(?::(\d{2}))?(?:([ap])m?)?$/.exec(s);
  if (!x) return null;
  let hs = x[1], ms = x[2];
  if (ms == null) {
    // "730" → 7:30, "1030" → 10:30.
    if (hs.length === 3) { ms = hs.slice(1); hs = hs.slice(0, 1); }
    else if (hs.length === 4) { ms = hs.slice(2); hs = hs.slice(0, 2); }
    else ms = "00";
  } else if (hs.length > 2) return null;
  let h = Number(hs);
  const m = Number(ms);
  if (m > 59 || h > 23) return null;
  if (x[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (x[3] === "p" ? 12 : 0);
  } else if (h >= 1 && h <= 12) return null;
  return { h, m };
}
