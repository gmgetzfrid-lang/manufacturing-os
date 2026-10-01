// lib/__tests__/helpers/schemaKeys.ts
//
// A census of supabase/ (schema.sql + the numbered migrations, in order) for
// the restore tripwires (admin-and-org Round G, P1): each table's columns and
// its ON CONFLICT-eligible keys — the PRIMARY KEY, every UNIQUE constraint
// (inline or table-level, CREATE or ALTER … ADD) and every NON-partial
// plain-column UNIQUE INDEX still standing after later DROP INDEX statements.
// A partial or expression index is no ON CONFLICT arbiter, so it is not a key
// here. And its FOREIGN KEYS still standing — inline `REFERENCES`, table-level
// `FOREIGN KEY (…) REFERENCES`, `ALTER … ADD COLUMN … REFERENCES` and
// `ALTER … ADD CONSTRAINT … FOREIGN KEY`, less any later `DROP CONSTRAINT`
// (by its declared or default `<table>_<cols>_fkey` name) or `DROP COLUMN`.
// A NOT VALID foreign key still binds every new row, so it counts. Comments
// are stripped; statements apply in source order within a file.
// P1 fix pass 2: also each foreign key's ON DELETE action, each table's
// NOT NULL columns (inline, PRIMARY KEY, ALTER … SET / DROP NOT NULL) and its
// GENERATED ALWAYS columns (a stored expression or an identity: Postgres
// refuses any non-DEFAULT value for them, 428C9).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ForeignKey {
  /** The constraint name (declared, or Postgres's default `<table>_<cols>_fkey`). */
  name: string;
  columns: string[];
  /** The referenced table; `public.` is dropped, any other schema is kept (`auth.users`). */
  parent: string;
  parentColumns: string[];
  /** The declared ON DELETE action, lower-cased ("cascade", "set null", …); "no action" when none is declared. */
  onDelete: string;
}
export interface TableShape { columns: Set<string>; keys: string[][]; fks: ForeignKey[]; notNull: Set<string>; generated: Set<string> }

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function splitTop(body: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      const j = body.indexOf("'", i + 1);
      if (j < 0) { cur += body.slice(i); break; } // unterminated literal: keep the rest as-is
      cur += body.slice(i, j + 1); i = j; continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const ident = (s: string) => s.replace(/"/g, "").trim().toLowerCase();
const colList = (s: string) => s.split(",").map(ident);

export function censusSchema(root = join(process.cwd(), "supabase")): Map<string, TableShape> {
  const files = [join(root, "schema.sql"), ...readdirSync(join(root, "migrations")).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort().map((n) => join(root, "migrations", n))];
  const tables = new Map<string, TableShape>();
  const namedIdx = new Map<string, { table: string; key: string[] }>();
  const get = (t: string) => { if (!tables.has(t)) tables.set(t, { columns: new Set(), keys: [], fks: [], notNull: new Set(), generated: new Set() }); return tables.get(t)!; };
  const parentName = (raw: string) => {
    const n = raw.replace(/"/g, "").trim().toLowerCase();
    return n.startsWith("public.") ? n.slice("public.".length) : n;
  };
  const onDeleteOf = (def: string) => {
    const m = def.match(/\bON\s+DELETE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)\b/i);
    return m ? m[1].toLowerCase().replace(/\s+/g, " ") : "no action";
  };
  const addFk = (t: string, name: string | undefined, columns: string[], parentRaw: string, parentCols: string | undefined, def: string) => {
    const fk: ForeignKey = {
      name: (name ?? `${t}_${columns.join("_")}_fkey`).replace(/"/g, "").toLowerCase(),
      columns,
      parent: parentName(parentRaw),
      parentColumns: parentCols ? colList(parentCols) : ["id"],
      onDelete: onDeleteOf(def),
    };
    const s = get(t);
    s.fks = s.fks.filter((x) => x.name !== fk.name);
    s.fks.push(fk);
  };
  const REF = String.raw`REFERENCES\s+((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)\s*(?:\(([^)]*)\))?`;
  const addKey = (t: string, k: string[]) => { const s = get(t); if (!s.keys.some((x) => x.length === k.length && x.every((c, i) => c === k[i]))) s.keys.push(k); };
  const colDef = (t: string, def: string) => {
    const m = def.match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
    if (!m) return;
    const c = m[1].toLowerCase();
    get(t).columns.add(c);
    if (/\bNOT\s+NULL\b/i.test(def) || /\bPRIMARY\s+KEY\b/i.test(def)) get(t).notNull.add(c);
    if (/\bGENERATED\s+ALWAYS\s+AS\b/i.test(def)) get(t).generated.add(c);
    if (/\bPRIMARY\s+KEY\b/i.test(def)) addKey(t, [c]);
    if (/\bUNIQUE\b/i.test(def) && !/\bUNIQUE\s*\(/i.test(def)) addKey(t, [c]);
    const ref = def.match(new RegExp(String.raw`(?:CONSTRAINT\s+"?([a-z_][a-z0-9_]*)"?\s+)?` + REF, "i"));
    if (ref) addFk(t, ref[1], [c], ref[2], ref[3], def);
  };
  const constraint = (t: string, def: string) => {
    const pk = def.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (pk) { addKey(t, colList(pk[1])); for (const c of colList(pk[1])) get(t).notNull.add(c); }
    const uq = def.match(/\bUNIQUE\s*(?:NULLS\s+NOT\s+DISTINCT\s*)?\(([^)]*)\)/i);
    if (uq) addKey(t, colList(uq[1]));
    const fk = def.match(new RegExp(String.raw`^(?:ADD\s+)?(?:CONSTRAINT\s+"?([a-z_][a-z0-9_]*)"?\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*` + REF, "i"));
    if (fk) addFk(t, fk[1], colList(fk[2]), fk[3], fk[4], def);
  };
  for (const f of files) {
    const src = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    // Statements are applied in source order (a file may drop and re-create an index).
    const events: Array<{ pos: number; run: () => void }> = [];
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    for (const m of src.matchAll(createRe)) {
      events.push({ pos: m.index ?? 0, run: () => {
        const t = m[1].toLowerCase();
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchParen(src, open);
        if (close < 0) return;
        get(t);
        for (const el of splitTop(src.slice(open + 1, close))) {
          if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i.test(el)) constraint(t, el);
          else colDef(t, el);
        }
      } });
    }
    const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+([\s\S]*?);/gi;
    for (const m of src.matchAll(alterRe)) {
      events.push({ pos: m.index ?? 0, run: () => {
        const t = m[1].toLowerCase();
        for (const act of splitTop(m[2])) {
          const add = act.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*)$/i);
          if (add) { colDef(t, add[1]); continue; }
          if (/^ADD\s+(CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\b/i.test(act)) { constraint(t, act); continue; }
          const nn = act.match(/^ALTER\s+(?:COLUMN\s+)?"?([a-z_][a-z0-9_]*)"?\s+(SET|DROP)\s+NOT\s+NULL\b/i);
          if (nn) { const s = get(t); if (nn[2].toUpperCase() === "SET") s.notNull.add(nn[1].toLowerCase()); else s.notNull.delete(nn[1].toLowerCase()); continue; }
          const dropCon = act.match(/^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i);
          if (dropCon) { const s = get(t); s.fks = s.fks.filter((x) => x.name !== dropCon[1].toLowerCase()); continue; }
          const dropCol = act.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i);
          if (dropCol) {
            const c = dropCol[1].toLowerCase();
            const s = get(t);
            s.columns.delete(c);
            s.notNull.delete(c);
            s.generated.delete(c);
            s.fks = s.fks.filter((x) => !x.columns.includes(c));
          }
        }
      } });
    }
    const idxRe = /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+ON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*(?:USING\s+\w+\s*)?\(/gi;
    for (const m of src.matchAll(idxRe)) {
      events.push({ pos: m.index ?? 0, run: () => {
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchParen(src, open);
        if (close < 0) return;
        const cols = src.slice(open + 1, close);
        const partial = /^\s*WHERE\b/i.test(src.slice(close + 1, close + 200));
        if (partial || !/^[\s"a-z0-9_,]+$/i.test(cols)) return; // partial / expression: never an ON CONFLICT arbiter
        const key = colList(cols);
        namedIdx.set(m[1].toLowerCase(), { table: m[2].toLowerCase(), key });
        addKey(m[2].toLowerCase(), key);
      } });
    }
    for (const m of src.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      events.push({ pos: m.index ?? 0, run: () => {
        const hit = namedIdx.get(m[1].toLowerCase());
        if (!hit) return;
        const s = get(hit.table);
        s.keys = s.keys.filter((k) => !(k.length === hit.key.length && k.every((c, i) => c === hit.key[i])));
        namedIdx.delete(m[1].toLowerCase());
      } });
    }
    for (const e of events.sort((a, b) => a.pos - b.pos)) e.run();
  }
  return tables;
}
