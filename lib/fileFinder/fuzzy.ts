// lib/fileFinder/fuzzy.ts — how far apart two spellings are.
//
// Plain Levenshtein with an early exit. Used on canonical codes and on
// single words, never on whole sentences, so the quadratic cost is on
// strings of a dozen characters.

export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** How many edits we forgive, by length: short strings forgive none, mid
 *  strings one, long strings two. "EP10115" vs "EP10151" is two edits on
 *  seven characters — close enough to mention, not close enough to trust. */
export function allowedEdits(len: number): number {
  if (len >= 7) return 2;
  if (len >= 5) return 1;
  return 0;
}

export function isClose(a: string, b: string): { close: boolean; edits: number } {
  const max = allowedEdits(Math.min(a.length, b.length));
  if (max === 0) return { close: false, edits: Infinity };
  const d = editDistance(a, b, max);
  return { close: d <= max, edits: d };
}
