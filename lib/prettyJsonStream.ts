// lib/prettyJsonStream.ts — JSON.stringify(value, null, 2), a piece at a time.
//
// intelligence ILIFE-11 criterion 2 (admin-and-org Round G, P14): the export
// built every table (and the JSON download, the whole envelope) as ONE string
// before sending it — for a workspace with tens of thousands of indexed
// passages that is hundreds of megabytes of text held at once, beside the
// rows it was made from. `prettyJsonChunks` yields the same text in pieces —
// the containers' punctuation, and each element down to `splitDepth` levels
// serialised on its own — so a caller can measure it, compress it or send it
// without ever holding all of it. The joined pieces are byte-identical to
// JSON.stringify(value, null, 2): an element JSON leaves out (undefined, a
// function, a symbol) is left out of an object and written null in an array,
// toJSON is honoured (a Date), and a boxed primitive is written as its value
// (lib/__tests__/aoRoundGP14ExportStream.test.ts compares them).

type Json = unknown;

/** What JSON.stringify writes for a value, after toJSON. */
function prepared(value: Json, key: string): Json {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return (value as { toJSON: (k: string) => Json }).toJSON(key);
  }
  return value;
}
const omitted = (v: Json) => v === undefined || typeof v === "function" || typeof v === "symbol";
const isContainer = (v: Json): v is object =>
  v !== null && typeof v === "object" && !(v instanceof Number) && !(v instanceof String) && !(v instanceof Boolean);

/** `value` as JSON.stringify(value, null, 2) writes it, in pieces:
 *  containers down to `splitDepth` levels are opened and closed here, and
 *  every deeper value is one JSON.stringify call re-indented. A top-level
 *  value JSON.stringify answers `undefined` for yields nothing. */
export function* prettyJsonChunks(value: Json, splitDepth = 2): Generator<string> {
  yield* emit(prepared(value, ""), splitDepth, "");
}

/** `v` already passed through toJSON (JSON.stringify calls it once). */
function* emit(v: Json, splitDepth: number, indent: string): Generator<string> {
  if (omitted(v)) return;
  if (splitDepth <= 0 || !isContainer(v)) {
    const s = JSON.stringify(v, null, 2);
    if (s === undefined) return;
    yield indent ? s.replace(/\n/g, `\n${indent}`) : s;
    return;
  }
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) { yield "[]"; return; }
    yield `[\n${inner}`;
    for (let i = 0; i < v.length; i++) {
      if (i > 0) yield `,\n${inner}`;
      const el = prepared(v[i], String(i));
      if (omitted(el)) { yield "null"; continue; }
      yield* emit(el, splitDepth - 1, inner);
    }
    yield `\n${indent}]`;
    return;
  }
  const entries = Object.keys(v)
    .map((k) => [k, prepared((v as Record<string, Json>)[k], k)] as const)
    .filter(([, el]) => !omitted(el));
  if (entries.length === 0) { yield "{}"; return; }
  yield `{\n${inner}`;
  for (let i = 0; i < entries.length; i++) {
    const [k, el] = entries[i];
    yield `${i > 0 ? `,\n${inner}` : ""}${JSON.stringify(k)}: `;
    yield* emit(el, splitDepth - 1, inner);
  }
  yield `\n${indent}}`;
}

/** Pieces joined into strings of at least `minChars` (the last may be
 *  shorter), so a stream sends a few large writes rather than one per row. */
export function* batchedChunks(pieces: Iterable<string>, minChars = 64 * 1024): Generator<string> {
  let buf: string[] = [];
  let size = 0;
  for (const p of pieces) {
    buf.push(p);
    size += p.length;
    if (size >= minChars) { yield buf.join(""); buf = []; size = 0; }
  }
  if (buf.length) yield buf.join("");
}

/** The UTF-8 byte length of JSON.stringify(value, null, 2), measured a piece
 *  at a time (nothing is kept). */
export function prettyJsonByteLength(value: Json, splitDepth = 2): number {
  let n = 0;
  for (const piece of batchedChunks(prettyJsonChunks(value, splitDepth))) n += Buffer.byteLength(piece, "utf8");
  return n;
}
