// notifications Round G, N4 — the realtime tripwire (RT-12 done-when 3) and
// the shape of 20261200_notif_roundG_realtime_publication_and_identity.sql
// (RT-4, RT-12, RT-10; DEC-30).
//
//   * Every table a `.on("postgres_changes", { … table: … })` names under
//     app / lib / components / hooks has an ADD TABLE to supabase_realtime in
//     supabase/ — or is a named exception with its reason. A subscription to
//     an unpublished table succeeds and never fires (RT-12), so this fails the
//     moment one is added without its publication statement.
//   * Every filtered subscription that can see DELETEs ('*' / 'DELETE') has an
//     unfiltered DELETE companion listener in its own file, filters on the
//     key, is on a table no application path hard-deletes (named, and checked
//     against the code), or is a named remainder with its owner (RT-4).
//     REPLICA IDENTITY FULL does NOT count: Supabase does not filter DELETE
//     events, and under row-level security the old record is the primary key
//     alone even with FULL (DEC-105 §4).
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
      // (a line comment may sit between the event name and its config — lib/libraryCollections.ts's companion)
      for (const m of s.matchAll(/["']postgres_changes["']\s*,\s*(?:\/\/[^\n]*\n\s*)*(\{[^}]*\})/g)) {
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

/** Every app source file (app / lib / components / hooks, tests excluded). */
function appSources(): string[] {
  return ["app", "lib", "components", "hooks"].flatMap((d) => walk(join(ROOT, d)));
}

/** A subscribed table deliberately NOT published, with its reason. */
const NOT_PUBLISHED: Record<string, string> = {
  // DEC-105 §5: Supabase applies no row-level security to
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

/** A filtered subscription with no DELETE companion in its own file yet —
 *  RT-4's remainder, with its owner (DEC-31). */
const RT4_PENDING: Record<string, string> = {
  // (The requests portal's tickets channel carries its unfiltered DELETE
  // companion since drafting-flow Round G, DF-P9 — RT-4's tickets limb; the
  // library page's documents channel since document-control Round G, P28 —
  // the last entry. Nothing is pending.)
};

/** A table whose rows no application path hard-deletes while a filtered
 *  listener could still care about them: its rows go when a parent row is
 *  deleted (ON DELETE CASCADE from the document, the org or the person) or,
 *  for notifications, by the admin purge — which deletes only READ, aged
 *  rows (app/api/admin/purge/route.ts floorOf), rows the attention feed's
 *  unread-filtered window never holds, so a DELETE it misses changes no
 *  number. A filtered listener on these misses nothing that matters — the
 *  soft-delete route, RT-4 done-when 3, for these tables. The tests below
 *  fail the moment app code deletes one directly, or a dynamic delete (the
 *  purge route's TARGETS) reaches one this map does not name as purged. */
const NO_APP_HARD_DELETE: Record<string, string> = {
  checkout_sessions: "a session ends by status (checked in / released) — an UPDATE the filtered listeners hear; only its document's delete cascades",
  checkout_messages: "a message is never deleted by the app; only its document's delete cascades",
  checkout_episodes: "an episode is sealed, never deleted by the app (20261075); only its document's delete cascades",
  notifications: "a notification is read, superseded or tombstoned (20261161) — UPDATEs; the admin purge hard-deletes only read, aged rows, which the unread-filtered feed never holds; otherwise only an org or person delete cascades",
};

/** The app's dynamic deletes (.from(<expression>).delete()) — a literal-name
 *  scan cannot see which table they reach, so each file's tables are read
 *  from its source here. */
const DYNAMIC_DELETES: Record<string, (source: string) => string[]> = {
  // the admin purge: the tables its TARGETS list names
  "app/api/admin/purge/route.ts": (s) => {
    const at = s.indexOf("const TARGETS");
    return [...s.slice(at, s.indexOf("];", at)).matchAll(/\btable:\s*"(\w+)"/g)].map((m) => m[1]);
  },
  // a superseded ingest batch withdraws the rows it inserted
  "lib/knowledgeIngest.ts": (s) => [...(s.match(/for \(const \[table, ids\] of \[([^\n]*)\] as const\)/)?.[1] ?? "").matchAll(/\["(\w+)"/g)].map((m) => m[1]),
  // the saved table views (its TABLE constant)
  "lib/tableViews.ts": (s) => [s.match(/const TABLE = "(\w+)"/)?.[1] ?? "?"],
};

describe("RT-4 — a filtered subscription that can see DELETEs hears them", () => {
  it("every filtered '*' / 'DELETE' subscription has an unfiltered DELETE companion, filters on the key, is on a table the app never hard-deletes, or is a named remainder — REPLICA IDENTITY FULL is not accepted", () => {
    const subs = subscriptions();
    const keyFiltered = (file: string, table: string) =>
      new RegExp(`table:\\s*(?:["']${table}["']|TABLE)\\s*,\\s*filter:\\s*\`id=eq\\.`).test(src(file));
    const offenders: string[] = [];
    for (const sub of subs.filter((x) => x.filtered && (x.event === "*" || x.event === "DELETE"))) {
      if (sub.table in NOT_PUBLISHED || sub.table in NO_APP_HARD_DELETE) continue;
      const companion = subs.some((x) => x.file === sub.file && x.table === sub.table && x.event === "DELETE" && !x.filtered);
      if (companion || keyFiltered(sub.file, sub.table)) continue;
      offenders.push(`${sub.file}:${sub.table}`);
    }
    expect([...new Set(offenders)].sort()).toEqual(Object.keys(RT4_PENDING).sort());
    // the attention feed carries the tickets companion
    expect(subs.some((x) => x.file === "hooks/useTicketNotifications.ts" && x.table === "tickets" && x.event === "DELETE" && !x.filtered)).toBe(true);
    // 20261200 does not set REPLICA IDENTITY FULL (it would not make a filtered DELETE listener hear anything)
    expect(src(MIGRATION).replace(/--[^\n]*/g, "")).not.toMatch(/REPLICA IDENTITY/i);
  });

  it("the tables named as never hard-deleted are not deleted by any app code", () => {
    const deleting: string[] = [];
    const dynamic: string[] = [];
    for (const f of appSources()) {
      const s = readFileSync(f, "utf8");
      for (const t of Object.keys(NO_APP_HARD_DELETE)) {
        if (new RegExp(`from\\(\\s*["']${t}["']\\s*\\)\\s*\\.delete\\(`).test(s)) deleting.push(`${relative(ROOT, f)}:${t}`);
      }
      // A delete whose table is an expression, not a literal.
      if (/\.from\(\s*[A-Za-z_$][\w$.]*\s*\)\s*\.delete\(/.test(s)) dynamic.push(relative(ROOT, f));
    }
    expect(deleting).toEqual([]);
    // Every dynamic delete is one this test reads (a new one must be added
    // to DYNAMIC_DELETES), and none reaches a table named above except the
    // purge's read-rows notifications line (checked in the next test).
    expect(dynamic.sort()).toEqual(Object.keys(DYNAMIC_DELETES).sort());
    const reached: string[] = [];
    for (const [file, tablesOf] of Object.entries(DYNAMIC_DELETES)) {
      const tables = tablesOf(src(file));
      expect(tables.length, file).toBeGreaterThan(0);
      expect(tables, file).not.toContain("?");
      for (const t of tables) if (t in NO_APP_HARD_DELETE) reached.push(`${file}:${t}`);
    }
    expect(reached).toEqual(["app/api/admin/purge/route.ts:notifications"]);
  });

  it("the admin purge reaches a never-hard-deleted table only as a read-rows purge the unread feed never holds", () => {
    const route = src("app/api/admin/purge/route.ts");
    const tables = DYNAMIC_DELETES["app/api/admin/purge/route.ts"](route);
    expect(tables).toEqual(expect.arrayContaining(["notifications", "email_notifications", "ai_usage_events"]));
    const reached = tables.filter((t) => t in NO_APP_HARD_DELETE);
    // Each such table's reason says so — a purge reaching checkout_* (or
    // any other table named here) fails until its reason is reconsidered.
    for (const t of reached) expect(NO_APP_HARD_DELETE[t], t).toMatch(/purge hard-deletes only read/);
    expect(reached).toEqual(["notifications"]);
    // …and the purge's notifications floor is read rows only.
    expect(route).toMatch(/if \(key === "notifications"\) \{\s*let n = q\.not\("read_at", "is", null\)/);
  });

  it("document-control P28: the library page's documents companion acts only on a document the page holds — it drops that row, never refetches", () => {
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    const at = page.indexOf('{ event: "DELETE", schema: "public", table: "documents" }');
    expect(at).toBeGreaterThan(0);
    const handler = page.slice(at, page.indexOf(".subscribe()", at));
    expect(handler).toMatch(/const gone = \(payload as \{ old\?: \{ id\?: string \} \| null \} \| undefined\)\?\.old\?\.id;\s*if \(!gone\) return;/);
    expect(handler).toMatch(/setDocuments\(\(prev\) => \(prev\.some\(\(d\) => d\.id === gone\) \? prev\.filter\(\(d\) => d\.id !== gone\) : prev\)\)/);
    expect(handler).not.toMatch(/setDocsRefreshTick/);
  });

  it("the attention feed's tickets companion acts only on a ticket the feed holds (Supabase sends every tenant's DELETEs to an unfiltered listener)", () => {
    const hook = src("hooks/useTicketNotifications.ts");
    expect(hook).toMatch(/event: 'DELETE', schema: 'public', table: 'tickets' \},\s*\(payload\) => \{[\s\S]{0,300}?ticketIdsRef\.current\.has\(gone\)\) schedule\(\);/);
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

  it("RT-4: no replica identity change (FULL would cost WAL on every documents UPDATE and match no filtered DELETE)", () => {
    expect(code).not.toMatch(/REPLICA IDENTITY/i);
    expect(code).not.toMatch(/relreplident/);
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
