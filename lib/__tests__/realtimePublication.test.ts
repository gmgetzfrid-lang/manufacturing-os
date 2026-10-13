// notifications Round G, N4 — the realtime tripwire (RT-12 done-when 3) and
// the shape of 20261200_notif_roundG_realtime_publication_and_identity.sql
// (RT-4, RT-12, RT-10; DEC-30).
//
//   * Every table a `.on("postgres_changes", { … table: … })` names under
//     app / lib / components / hooks has an ADD TABLE to supabase_realtime in
//     supabase/ — or is a named exception with its reason. A subscription to
//     an unpublished table succeeds and never fires (RT-12), so this fails the
//     moment one is added without its publication statement.
//   * Every table with a DELETE-capable subscription filtered on a non-key
//     column is REPLICA IDENTITY FULL somewhere in the sequence, or carries an
//     unfiltered DELETE companion listener (RT-4).
//   * The migration is one DEC-30 paste: the counts-only inventory before the
//     transaction, BEGIN / COMMIT, one final (check, ok, n) SELECT.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261200_notif_roundG_realtime_publication_and_identity.sql";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every postgres_changes subscription: its file, table, event and filter. */
function subscriptions(): Array<{ file: string; table: string; event: string; filtered: boolean }> {
  const out: Array<{ file: string; table: string; event: string; filtered: boolean }> = [];
  for (const dir of ["app", "lib", "components", "hooks"]) {
    for (const f of walk(join(ROOT, dir))) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/["']postgres_changes["']\s*,\s*(\{[^}]*\})/g)) {
        const cfg = m[1];
        const lit = cfg.match(/table:\s*["']([a-z_0-9]+)["']/);
        let table = lit?.[1];
        if (!table) {
          const ident = cfg.match(/table:\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
          if (ident) table = s.match(new RegExp(`const ${ident}\\s*=\\s*["']([a-z_0-9]+)["']`))?.[1];
        }
        if (!table) throw new Error(`${relative(ROOT, f)}: a postgres_changes subscription whose table could not be read: ${cfg}`);
        out.push({
          file: relative(ROOT, f),
          table,
          event: cfg.match(/event:\s*["']([A-Z*]+)["']/)?.[1] ?? "?",
          filtered: /filter:/.test(cfg),
        });
      }
    }
  }
  return out;
}

/** Every table some SQL file in supabase/ adds to supabase_realtime. */
function published(): Set<string> {
  const set = new Set<string>();
  const files = [join(ROOT, "supabase/schema.sql"), ...readdirSync(join(ROOT, "supabase/migrations")).map((f) => join(ROOT, "supabase/migrations", f))];
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const s = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    for (const m of s.matchAll(/ALTER PUBLICATION\s+supabase_realtime\s+ADD TABLE\s+([^;]+);/gi)) {
      for (const t of m[1].split(",")) set.add(t.trim().replace(/^public\./, ""));
    }
  }
  return set;
}

/** Every table some SQL file sets REPLICA IDENTITY FULL. */
function fullIdentity(): Set<string> {
  const set = new Set<string>();
  for (const f of readdirSync(join(ROOT, "supabase/migrations"))) {
    if (!f.endsWith(".sql")) continue;
    const s = readFileSync(join(ROOT, "supabase/migrations", f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of s.matchAll(/ALTER TABLE\s+(?:public\.)?([a-z_0-9]+)\s+REPLICA IDENTITY FULL/gi)) set.add(m[1]);
  }
  return set;
}

/** A subscribed table deliberately NOT published, with its reason. */
const NOT_PUBLISHED: Record<string, string> = {
  // DEC-44 (N4-feed-provider) §5: Supabase applies no row-level security to
  // DELETE events, and a table_views key is a composite text id naming the
  // workspace, the person and the library (lib/tableViews.ts tableViewId) —
  // publishing it would hand those ids, across workspaces, to any DELETE
  // subscriber. Its cross-client live sync stays off (RT-12, residual).
  table_views: "a DELETE would leak the composite id (workspace, person, library) to every subscriber",
};

describe("RT-12 dw3 — every realtime-subscribed table has its publication statement", () => {
  const subs = subscriptions();
  const pub = published();

  it("the census sees the app's subscriptions (sanity)", () => {
    expect(subs.length).toBeGreaterThanOrEqual(15);
    for (const t of ["tickets", "notifications", "documents", "checkout_sessions", "milestones", "table_views", "collections"]) {
      expect(subs.some((s) => s.table === t), t).toBe(true);
    }
  });

  it("each subscribed table is published, or a named exception", () => {
    const missing = [...new Set(subs.map((s) => s.table))].filter((t) => !pub.has(t) && !(t in NOT_PUBLISHED));
    expect(missing).toEqual([]);
    // an exception that became published (or unsubscribed) is dropped from the list
    for (const t of Object.keys(NOT_PUBLISHED)) {
      expect(pub.has(t), t).toBe(false);
      expect(subs.some((s) => s.table === t), t).toBe(true);
    }
  });

  it("milestones is published (20261106, re-asserted by 20261200)", () => {
    expect(pub.has("milestones")).toBe(true);
  });
});

/** A filtered subscription on a default-identity table that has no DELETE
 *  companion in its own file yet — RT-4's remainder, with its owner. */
const RT4_PENDING: Record<string, string> = {
  // The requests portal's tickets channel (org filter). tickets keeps the
  // default identity (DEC-44 (N4-feed-provider) §4) and no app path
  // hard-deletes a ticket; the companion listener is one line in a file
  // notifications N4 does not hold (RT-4 Partial, owner: drafting-flow).
  "app/(protected)/requests/page.tsx:tickets": "drafting-flow: add the unfiltered tickets DELETE companion (RT-4)",
};

describe("RT-4 — a filtered subscription that can see DELETEs can match them", () => {
  it("every filtered '*' / 'DELETE' subscription is on a REPLICA IDENTITY FULL table, filters on the key, or has an unfiltered DELETE companion in its own file", () => {
    const subs = subscriptions();
    const full = fullIdentity();
    const keyFiltered = (file: string, table: string) =>
      new RegExp(`table:\\s*(?:["']${table}["']|TABLE)\\s*,\\s*filter:\\s*\`id=eq\\.`).test(src(file));
    const offenders: string[] = [];
    for (const sub of subs.filter((x) => x.filtered && (x.event === "*" || x.event === "DELETE"))) {
      if (full.has(sub.table) || sub.table in NOT_PUBLISHED) continue;
      const companion = subs.some((x) => x.file === sub.file && x.table === sub.table && x.event === "DELETE" && !x.filtered);
      if (companion || keyFiltered(sub.file, sub.table)) continue;
      offenders.push(`${sub.file}:${sub.table}`);
    }
    expect([...new Set(offenders)].sort()).toEqual(Object.keys(RT4_PENDING).sort());
    for (const t of ["documents", "checkout_sessions", "libraries", "collections", "notifications"]) expect(full.has(t), t).toBe(true);
    expect(full.has("tickets")).toBe(false);
    expect(subs.some((x) => x.file === "hooks/useTicketNotifications.ts" && x.table === "tickets" && x.event === "DELETE" && !x.filtered)).toBe(true);
  });
});

describe("20261200 — one DEC-30 paste", () => {
  const sql = src(MIGRATION);
  const code = sql.replace(/--[^\n]*/g, "");
  const begin = code.indexOf("\nBEGIN;");
  const commit = code.indexOf("\nCOMMIT;");

  it("a counts-only inventory BEFORE the transaction, BEGIN / COMMIT, then ONE final (check, ok, n) SELECT", () => {
    expect(code.indexOf("CREATE TEMP TABLE notif_round_g_1200_before")).toBeGreaterThan(0);
    expect(code.indexOf("CREATE TEMP TABLE notif_round_g_1200_before")).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(code.split(/\nBEGIN;/).length - 1).toBe(1);
    expect(code.split(/\nCOMMIT;/).length - 1).toBe(1);
    const tail = code.slice(commit + "\nCOMMIT;".length);
    expect(tail.match(/^\s*SELECT\s/gm)?.length).toBe(tail.match(/^SELECT /gm)?.length);
    expect(tail.trim().startsWith("SELECT ")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,[\s\S]*?NULL::text AS n/);
    expect(tail.trim().endsWith("FROM (SELECT inventory, n FROM notif_round_g_1200_before ORDER BY ord) b;")).toBe(true);
    // the inventory reads counts only — never a customer row
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE"), begin);
    for (const sel of inv.matchAll(/\(SELECT ([^()]*?)(?:\(|FROM)/g)) expect(sel[1].trim()).toMatch(/^COUNT/);
  });

  it("RT-4: REPLICA IDENTITY FULL on documents, checkout_sessions, libraries, collections — and not on tickets", () => {
    const tx = code.slice(begin, commit);
    for (const t of ["documents", "checkout_sessions", "libraries", "collections"]) expect(tx).toContain(`ALTER TABLE ${t} REPLICA IDENTITY FULL;`);
    expect(tx).not.toMatch(/ALTER TABLE tickets REPLICA IDENTITY/);
  });

  it("RT-12: milestones re-asserted with 20261106's guard; table_views is not added", () => {
    const tx = code.slice(begin, commit);
    expect(tx).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_publication_tables\s+WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones'\) THEN\s+ALTER PUBLICATION supabase_realtime ADD TABLE public\.milestones;/);
    expect(code).not.toMatch(/ADD TABLE (public\.)?table_views/);
  });

  it("RT-10: the five toast_on_* columns, NOT NULL DEFAULT TRUE, idempotent — the email toggles' categories", async () => {
    const { TOAST_CATEGORY_COLUMNS } = await import("@/lib/notificationPrefs");
    const tx = code.slice(begin, commit);
    for (const c of TOAST_CATEGORY_COLUMNS) {
      expect(tx).toContain(`ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS ${c} BOOLEAN NOT NULL DEFAULT TRUE;`);
    }
    expect(TOAST_CATEGORY_COLUMNS.map((c) => c.replace("toast_on_", "email_on_"))).toEqual(
      ["email_on_mention", "email_on_assignment", "email_on_status_change", "email_on_watched_activity", "email_on_sla_warning"],
    );
  });

  it("defines no function, policy or trigger (nothing to re-create from a newer body)", () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)/i);
    expect(code).not.toMatch(/SECURITY DEFINER/i);
  });
});
