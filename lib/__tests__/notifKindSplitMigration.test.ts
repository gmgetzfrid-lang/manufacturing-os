// notifications Round G — N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, the database
// half: supabase/migrations/20261191_notif_roundG_kind_split.sql.
//
//   · notification_kinds() re-created from its NEWEST definition (found by
//     scanning the sequence below this file) with exactly the nine N9 rows
//     added, each with the registry's compliance flag, nothing removed
//     (lineDiff);
//   · email_gate() re-created from its NEWEST definition with two event types
//     added to the exempt list (DELIV-15, DEC-90 A10) — the only code change
//     (lineDiff) — and the list equal to lib/notificationPrefs.ts
//     PREFERENCE_EXEMPT_EVENT_TYPES;
//   · notifications_i_sent(...) (OS-6 / TAX-16): SECURITY DEFINER, search_path
//     pinned, EXECUTE to authenticated only (DRLS-16), the caller's own rows of
//     the two nudge kinds only, never a title or body;
//   · the backlog re-files, one per discriminator the producers wrote, in the
//     order that keeps each row's meaning;
//   · the DEC-30 one-paste shape: header, guard, counts-only TEMP inventory
//     BEFORE the one BEGIN … COMMIT, ONE final (check, ok, n) statement.
// It was exercised on a throwaway PostgreSQL 16 (records, PROD-13): pasted
// twice over 20261148 / 20261160 / 20261161 / 20261181 with a seeded backlog.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";
import { PREFERENCE_EXEMPT_EVENT_TYPES } from "@/lib/notificationPrefs";
import { EXPECTED_FUNCTIONS } from "@/lib/schemaExpectations";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILE = "20261191_notif_roundG_kind_split.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const CODE = strip(SQL);
const NEW_KINDS = [
  "checkout_force_released", "checkout_auto_released", "doc_recalled", "doc_upstream_changed",
  "package_doc_stale", "package_doc_retired", "transmittal_issued", "intake_quote", "intake_submission",
];

/** Every `CREATE OR REPLACE FUNCTION name(` body in [file, text] order. */
function definitionsOf(name: string, files: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      out.push([f, s.slice(m.index!, end + tag[0].length + 1)]);
    }
  }
  return out;
}
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};
const valuesOf = (body: string) => [...body.matchAll(/\('(\w+)',\s*(true|false)\)/g)].map((m) => [m[1], m[2] === "true"] as const);

describe("20261191 — one paste for the SQL editor (DEC-30)", () => {
  it("opens with a header; stops first when 20261160 or 20261148 is missing; inventory in a TEMP table BEFORE the one BEGIN … COMMIT", () => {
    expect(SQL.startsWith("-- ─")).toBe(true);
    const guard160 = CODE.indexOf("RAISE EXCEPTION '20261191 needs 20261160");
    const guard148 = CODE.indexOf("RAISE EXCEPTION '20261191 needs 20261148");
    const temp = CODE.indexOf("CREATE TEMP TABLE notif_round_g_191_before");
    expect(guard160).toBeGreaterThan(0);
    expect(guard148).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(Math.max(guard160, guard148));
    expect(CODE.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(temp).toBeLessThan(CODE.indexOf("BEGIN;"));
  });

  it("ends with ONE statement after COMMIT: the (check, ok, n) probes, then the inventory rows", () => {
    const tail = CODE.slice(CODE.indexOf("COMMIT;") + "COMMIT;".length);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM notif_round_g_191_before ORDER BY ord\) b;/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = CODE.slice(CODE.indexOf("CREATE TEMP TABLE"), CODE.indexOf("BEGIN;"));
    const branches = inv.split(/UNION ALL/);
    expect(branches).toHaveLength(11);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT \*|\btitle\b|\bbody\b|actor_name|display_name|\bemail\b/i);
  });

  it("DRLS-16: every SECURITY DEFINER function pins search_path and is REVOKEd from PUBLIC and anon; EXECUTE never to anon or PUBLIC", () => {
    const defs = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([\s\S]*?)\)\s*RETURNS[\s\S]*?AS \$\$/g)];
    expect(defs.map((d) => d[1])).toEqual(["notification_kinds", "email_gate", "notifications_i_sent"]);
    for (const d of defs) {
      expect(d[0], d[1]).toMatch(/SET search_path = public/);
      expect(CODE, d[1]).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${d[1]}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(CODE).not.toMatch(new RegExp(`GRANT[^;]*${d[1]}[^;]*\\b(anon|PUBLIC)\\b`));
    }
    expect(defs.filter((d) => /SECURITY DEFINER/.test(d[0])).map((d) => d[1])).toEqual(["email_gate", "notifications_i_sent"]);
    // the read-back is a member's: authenticated only (the server never needs it)
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION notifications_i_sent(uuid, text, timestamptz, text, text, jsonb) TO authenticated;");
  });

  it("never touches a notifications policy or a trigger (20261160 / 20261161 own them)", () => {
    expect(CODE).not.toMatch(/(?:DROP|CREATE|ALTER) POLICY/);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION enforce_notification_(insert|update)/);
    expect(CODE).not.toMatch(/DROP TRIGGER|CREATE TRIGGER/);
  });
});

describe("20261191 — notification_kinds() from its NEWEST definition, plus N9's nine kinds", () => {
  const before = definitionsOf("notification_kinds", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = definitionsOf("notification_kinds", [FILE]);

  it("the newest earlier definition is found by scanning the sequence (today 20261181), and this file defines it once", () => {
    expect(before[0] < FILE).toBe(true);
    expect(before[0]).toBe("20261181_notif_roundG_producers_free.sql");
    expect(mine).toHaveLength(1);
  });

  it("removes no line and adds exactly the nine rows, each with the registry's compliance flag", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA).toEqual([]);
    const added = d.onlyInB.map((l) => l.trim());
    expect(added).toHaveLength(NEW_KINDS.length);
    for (const k of NEW_KINDS) {
      const flag = KIND_META[k as keyof typeof KIND_META].compliance;
      expect(added, k).toContainEqual(expect.stringMatching(new RegExp(`^\\('${k}',\\s+${flag}\\),$`)));
    }
  });

  it("the split kinds keep their parent's compliance flag — so the dismiss-only rule and the digest treat a re-filed row as before", () => {
    const flag = (k: string) => KIND_META[k as keyof typeof KIND_META].compliance;
    for (const k of ["doc_recalled", "doc_upstream_changed", "package_doc_stale", "package_doc_retired"]) expect(flag(k), k).toBe(flag("doc_superseded"));
    for (const k of ["checkout_force_released", "checkout_auto_released"]) expect(flag(k), k).toBe(flag("checkout_released"));
    for (const k of ["intake_quote", "intake_submission"]) expect(flag(k), k).toBe(flag("review_requested"));
    expect(flag("transmittal_issued")).toBe(false);
  });

  it("its own probe states its own list's counts — derived from the VALUES it holds", () => {
    const values = valuesOf(mine[0][1]);
    const n = values.length, c = values.filter(([, x]) => x).length;
    expect(n).toBe(valuesOf(before[1]).length + NEW_KINDS.length);
    expect(SQL).toContain(`COUNT(*) = ${n} AND COUNT(DISTINCT kind) = ${n} AND COUNT(*) FILTER (WHERE compliance) = ${c}`);
  });

  it("restates EXECUTE: authenticated and service_role", () => {
    expect(CODE).toContain("REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;");
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;");
  });
});

describe("20261191 — email_gate() from its NEWEST definition: the transmittal notices join the exempt list (DELIV-15, DEC-90 A10)", () => {
  const before = definitionsOf("email_gate", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = definitionsOf("email_gate", [FILE]);

  it("the newest earlier definition is 20261148's, and this file defines it once", () => {
    expect(before[0]).toBe("20261148_notif_roundG_prefs_gate.sql");
    expect(mine).toHaveLength(1);
  });

  it("the only code change is the exempt list (comment lines may be added, none removed)", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA.map((l) => l.trim())).toEqual(["IF COALESCE(p_event_type, '') NOT IN ('safety_recall', 'safety_alert') THEN"]);
    const code = d.onlyInB.filter((l) => !/^\s*--/.test(l)).map((l) => l.trim());
    expect(code).toEqual(["IF COALESCE(p_event_type, '') NOT IN ('safety_recall', 'safety_alert', 'transmittal_unstamped', 'transmittal_refused') THEN"]);
  });

  it("the database's exempt list equals the app's PREFERENCE_EXEMPT_EVENT_TYPES (the fallback gate reads the app's)", () => {
    const m = mine[0][1].match(/NOT IN \(([^)]*)\) THEN/)!;
    const list = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    expect(list).toEqual([...PREFERENCE_EXEMPT_EVENT_TYPES]);
  });

  it("restates EXECUTE: authenticated and service_role; the receipt email's event (watcher_activity) stays gated", () => {
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;");
    expect(mine[0][1]).toContain("WHEN 'watcher_activity'          THEN v_prefs.email_on_watched_activity");
  });
});

describe("20261191 — notifications_i_sent(): a member reads back only the nudges they sent (OS-6 / TAX-16)", () => {
  const fn = definitionsOf("notifications_i_sent", [FILE]);
  const body = fn[0]?.[1] ?? "";

  it("is defined once, here, and nowhere earlier", () => {
    expect(fn).toHaveLength(1);
    expect(definitionsOf("notifications_i_sent", FILES.filter((f) => f < FILE))).toEqual([]);
  });

  it("answers recipient, resource and time — never a title, body or metadata", () => {
    expect(body).toMatch(/RETURNS TABLE \(user_id uuid, resource_type text, resource_id text, created_at timestamptz\)/);
    expect(body).toMatch(/SELECT n\.user_id, n\.resource_type, n\.resource_id, n\.created_at\s+FROM notifications n/);
    expect(body).not.toMatch(/n\.title|n\.body|SELECT n\.metadata/);
  });

  it("only for a signed-in ACTIVE member of the org, only their own rows, only the two nudge kinds, inside 30 days, bounded", () => {
    for (const term of [
      "auth.uid() IS NOT NULL",
      "p_kind IN ('overlap_advisory', 'checkout_conflict')",
      "m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active'",
      "n.org_id = p_org",
      "n.actor_user_id = auth.uid()",
      "n.kind = p_kind",
      "n.created_at >= GREATEST(COALESCE(p_since, now()), now() - interval '30 days')",
      "LIMIT 500",
    ]) expect(body, term).toContain(term);
    expect(body).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/);
  });

  it("the schema-health panel probes it, with an argument its type refuses (the body never runs)", () => {
    const row = EXPECTED_FUNCTIONS.find((f) => f.fn === "notifications_i_sent")!;
    expect(row).toMatchObject({ migration: FILE, signature: "notifications_i_sent(uuid, text, timestamptz, text, text, jsonb)" });
    expect(Object.keys(row.probeArgs).sort()).toEqual(["p_kind", "p_org", "p_since"]);
    expect(String(row.probeArgs.p_org)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("the app reads it with the same argument names (lib/sentNotices.ts)", () => {
    const app = readFileSync(join(ROOT, "lib/sentNotices.ts"), "utf8");
    expect(app).toMatch(/rpc\("notifications_i_sent", \{\s*p_org: input\.orgId,\s*p_kind: input\.kind,\s*p_since: input\.since,\s*p_resource_type: [^,]+,\s*p_resource_id: [^,]+,\s*p_metadata: [^,]+,\s*\}\)/);
  });
});

describe("20261191 — the backlog re-filed by the discriminators the producers wrote (TAX-13 dw2)", () => {
  const updates = [...CODE.matchAll(/UPDATE notifications SET kind = '(\w+)'\s+WHERE kind = '(\w+)'([^;]*);/g)]
    .map((m) => ({ to: m[1], from: m[2], where: m[3].replace(/\s+/g, " ").trim() }));

  it("one UPDATE per discriminator, each changing only `kind`, inside the transaction", () => {
    expect(updates).toEqual([
      { to: "ack_requested", from: "doc_superseded", where: "AND metadata ? 'ackRequest'" },
      { to: "doc_recalled", from: "doc_superseded", where: "AND metadata ? 'recall'" },
      { to: "package_doc_stale", from: "doc_superseded", where: "AND metadata ? 'workPackageId'" },
      { to: "package_doc_retired", from: "doc_superseded", where: "AND metadata ? 'packageId' AND metadata ? 'retirement'" },
      { to: "checkout_auto_released", from: "checkout_released", where: "AND metadata ? 'autoReleasedSessionId'" },
      { to: "intake_quote", from: "review_requested", where: "AND metadata ? 'intake' AND metadata ? 'quote'" },
      { to: "intake_submission", from: "review_requested", where: "AND metadata ? 'intake'" },
    ]);
    const begin = CODE.indexOf("BEGIN;"), commit = CODE.indexOf("COMMIT;");
    for (const m of CODE.matchAll(/UPDATE notifications SET/g)) {
      expect(m.index!).toBeGreaterThan(begin);
      expect(m.index!).toBeLessThan(commit);
    }
    expect(CODE).not.toMatch(/UPDATE notifications SET (?!kind = )/);
  });

  it("each discriminator is the one its producer writes today (the re-file follows the app, not a guess)", () => {
    const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
    expect(src("lib/distributionAcks.ts")).toMatch(/ackRequest: true/);
    expect(src("lib/staleCopies.ts")).toMatch(/recall: true/);
    expect(src("lib/workPackages.ts")).toMatch(/workPackageId/);
    expect(src("lib/postPublish.ts")).toMatch(/packageId[\s\S]*retirement/);
    expect(src("lib/projects.ts")).toMatch(/autoReleasedSessionId/);
    expect(src("app/api/intake/upload/route.ts")).toMatch(/metadata: \{ intake: true, \.\.\.n\.metadata \}/);
    expect(src("app/api/intake/upload/route.ts")).toMatch(/quote(Id)?: /);
  });

  it("every target is a kind the re-created allow-list declares", () => {
    const declared = valuesOf(definitionsOf("notification_kinds", [FILE])[0][1]).map(([k]) => k);
    for (const u of updates) expect(declared, u.to).toContain(u.to);
  });

  it("a probe reports none left after", () => {
    expect(CODE).toMatch(/'AFTER: no doc_superseded row carries a discriminator[^']*',\s*NOT EXISTS \(SELECT 1 FROM notifications/);
  });
});
