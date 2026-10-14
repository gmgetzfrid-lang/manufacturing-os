// notifications Round G — N10 PUSH fix pass, the database half:
// supabase/migrations/20261211_notif_roundG_push_subscriptions_writer.sql.
//
//   · the review's blocker / OS-10 done-when 3: push_sub_insert_own (newest
//     and only definition: 20260804, found by scanning the sequence) is
//     DROPPED, so a signed-in member can no longer insert a device row with
//     an endpoint of their choosing; push_sub_select_own and
//     push_sub_delete_own stay as they are (the settings card reads its own
//     row; a member may remove their own device);
//   · no row is changed (no INSERT / UPDATE / DELETE), no policy is created,
//     nothing is re-created;
//   · the DEC-30 one-paste shape: inventory (aggregate counts only) in a TEMP
//     table BEFORE the one BEGIN … COMMIT, ONE final (check, ok, n) statement;
//   · the inventory's push-service pattern names the same hosts as the app's
//     allow-list (lib/push/endpoints.ts — the authority).
// No database in this suite: the SQL is pinned by shape (the PostgreSQL 16 run
// is recorded in the file's header and under OS-10).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PUSH_SERVICE_HOSTS, PUSH_SERVICE_HOST_SUFFIXES, PUSH_DEVICE_CAP } from "@/lib/push/endpoints";
import { PUSH_OPT_IN_SINCE } from "@/lib/notify/dispatch";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261211_notif_roundG_push_subscriptions_writer.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const CODE = SQL.replace(/--[^\n]*/g, "");

/** The files (in sequence order) whose code — comments stripped — creates or drops `policy` on push_subscriptions. */
const touching = (verb: "CREATE" | "DROP", policy: string) =>
  FILES.filter((f) => new RegExp(`${verb} POLICY (IF EXISTS )?"?${policy}"? ON (public\\.)?push_subscriptions\\b`, "i").test(read(f).replace(/--[^\n]*/g, "")));

describe("20261211 — push_subscriptions has one writer, the service-role route (N10 fix pass)", () => {
  it("is in the numbered sequence under this package's number, and after 20260804", () => {
    expect(FILES).toContain(FILE);
    expect(FILES.indexOf(FILE)).toBeGreaterThan(FILES.indexOf("20260804_push_subscriptions.sql"));
  });

  it("drops push_sub_insert_own — whose newest (and only) definition is 20260804 — and nothing re-creates it after", () => {
    expect(touching("CREATE", "push_sub_insert_own")).toEqual(["20260804_push_subscriptions.sql"]);
    expect(CODE).toMatch(/DROP POLICY IF EXISTS push_sub_insert_own ON push_subscriptions;/);
    const after = FILES.slice(FILES.indexOf(FILE) + 1);
    expect(after.filter((f) => touching("CREATE", "push_sub_insert_own").includes(f))).toEqual([]);
  });

  it("leaves the own-row SELECT and DELETE policies alone, creates no policy, changes no row, re-creates nothing", () => {
    expect(CODE).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?(POLICY|FUNCTION|TRIGGER)\b/i);
    expect(CODE).not.toMatch(/push_sub_select_own ON|push_sub_delete_own ON/);
    expect(CODE).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b|\bTRUNCATE\b/i);
    expect(CODE.match(/\bDROP POLICY\b/g)).toHaveLength(1);
  });

  it("DEC-30 one-paste shape: TEMP inventory before ONE BEGIN … COMMIT; ONE final (check, ok, n) SELECT; counts only", () => {
    const temp = CODE.indexOf("CREATE TEMP TABLE notif_round_g_211_before AS");
    const begin = CODE.indexOf("BEGIN;");
    const commit = CODE.indexOf("COMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE.indexOf("DROP POLICY IF EXISTS push_sub_insert_own")).toBeGreaterThan(begin);
    expect(CODE.indexOf("DROP POLICY IF EXISTS push_sub_insert_own")).toBeLessThan(commit);
    // after COMMIT: exactly one statement, the final SELECT
    const tail = CODE.slice(commit + "COMMIT;".length).trim();
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim() !== "")).toHaveLength(1);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,/);
    expect(tail).toMatch(/AS ok,\s*NULL::text AS n\s*UNION ALL/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM notif_round_g_211_before ORDER BY ord\) b;$/);
    // the inventory is aggregate counts, never a customer row
    const inv = CODE.slice(temp, begin);
    expect(inv.match(/\(SELECT COUNT\(\*\) FROM/g)?.length).toBe(5);
    expect(inv.match(/\bUNION ALL\b/g)).toHaveLength(4);
    expect(inv).not.toMatch(/SELECT\s+(endpoint|p256dh|auth|user_id)\b/i);
    // probes: four booleans, a deparsed-qual LIKE with no cast in the pattern
    expect(tail.match(/UNION ALL/g)).toHaveLength(4);
    expect(tail).toMatch(/qual LIKE '%auth\.uid\(\) = user_id%'/);
    expect(tail).not.toMatch(/LIKE '[^']*::/);
  });

  it("the inventory's push-service pattern names exactly the app's allow-list (lib/push/endpoints.ts), the cap and the opt-in instant", () => {
    const m = /!~ '\^https:\/\/\(([^)]+)\)\(\/\|\\\?\|#\|\$\)'/.exec(CODE);
    expect(m, "the endpoint pattern").toBeTruthy();
    const alts = m![1].split("|");
    const exact = alts.filter((a) => !a.startsWith("[a-z0-9.-]+")).map((a) => a.replace(/\\\./g, "."));
    const suffix = alts.filter((a) => a.startsWith("[a-z0-9.-]+")).map((a) => a.slice("[a-z0-9.-]+".length).replace(/\\\./g, "."));
    expect(exact.sort()).toEqual([...PUSH_SERVICE_HOSTS].sort());
    expect(suffix.sort()).toEqual([...PUSH_SERVICE_HOST_SUFFIXES].sort());
    expect(CODE).toContain(`HAVING COUNT(*) > ${PUSH_DEVICE_CAP}`);
    expect(CODE).toContain(`created_at < timestamptz '${PUSH_OPT_IN_SINCE.slice(0, 10)} 00:00:00+00'`);
    expect(PUSH_OPT_IN_SINCE).toBe("2026-10-14T00:00:00.000Z");
  });

  it("the app never inserts a device row as a signed-in member (so it works the same before and after the paste)", () => {
    const card = readFileSync(join(process.cwd(), "components/settings/PushOptIn.tsx"), "utf8");
    expect(card).not.toMatch(/from\("push_subscriptions"\)\.(insert|upsert|update)/);
    const route = readFileSync(join(process.cwd(), "app/api/push/subscribe/route.ts"), "utf8");
    expect(route).toContain('import { supabaseAdmin } from "@/lib/supabaseAdmin";');
    expect(route).toMatch(/supabaseAdmin\s*\n?\s*\.from\("push_subscriptions"\)\s*\n?\s*\.insert\(/);
  });
});
