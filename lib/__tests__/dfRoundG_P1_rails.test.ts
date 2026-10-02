// Drafting-flow Round G, package DF-P1 RAILS — the ticket row's remaining
// rails, the audit write that can fail loudly, the read_at evidence, the
// comment RPC identity.
//
//   * Migration 20261166: ticket_update_guard re-created from its NEWEST
//     earlier body (found by scanning — 20261038 today), lineDiff-pinned: no
//     base line removed, the added lines exactly DF-P1's. A census decides
//     every one of the 41 tickets columns. post_ticket_comment re-created from
//     its newest body (20260810) with identity stamping and merged arrays;
//     EXECUTE revoked from authenticated. tickets_org_access split per verb.
//     AUTHZ-13's Contractor read scope. append_ticket_redline (SM-9). PERS-4's
//     foreign key. DEC-30 shape. The script was run on a throwaway PostgreSQL
//     16 (both foreign-key worlds, applied repeatedly for idempotency; 42
//     behavioural cases plus six for the redline append) — recorded on SM-2 /
//     PERS-1 / AUTHZ-8 / AUTHZ-13 / SM-9 / PERS-4.
//   * The workflow-action route: strict policy read (AUTHZ-7), vetted
//     attachments (AUTHZ-11 / SM-13), checked audit write (EVID-12 / SM-7),
//     supersede marker (EVID-13), absolute email links (EDGE-9), the null-token
//     leg (EDGE-15), member-stamped drafter names (SM-12), the org-scoped
//     intent bridge (SM-14), the engineer note (AUTHZ-14), the register-backed
//     close (DCW-4 / HAND-3).
//   * The comment route's absolute links (EDGE-9) and compare-and-set legacy
//     write (SM-9); the intake redline append (SM-9 — intakeUploadRoute.test);
//     lib/audit.ts (EVID-6 / PERS-7); the badge hook and the unread list
//     (EVID-13).
//
// Route tests drive the real handlers against a Proxy-chain supabaseAdmin
// (the sweepRoundD3 / dfRoundG_P0 pattern) extended with `.is` filters and
// per-call error injection, so refusals and failure paths are observed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment } from "@/types/schema";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261166_df_roundG_ticket_rails.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));

// ═════════════════════════════════════════════════════════════════════════════
// 1. The migration
// ═════════════════════════════════════════════════════════════════════════════
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION ticket_update_guard()";
const guardDefiners = files.filter((f) => stripComments(mig(f)).includes(GUARD_HEAD));
const GUARD_PREV = guardDefiners[guardDefiners.indexOf(FILE) - 1];
const G = { live: between(mig(GUARD_PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };

/** Every column of tickets: supabase/schema.sql's 38 + the three migrations add. */
const TICKET_COLUMNS = (() => {
  const t = between(src("supabase/schema.sql"), "CREATE TABLE IF NOT EXISTS tickets (", "\n);");
  const cols = [...t.matchAll(/^\s{2}([a-z_]+)\s+(?:UUID|TEXT|INT|JSONB|TIMESTAMPTZ|TEXT\[\]|UUID\[\])/gm)].map((m) => m[1]);
  return [...cols, "deliverable_rev", "draft_iteration", "search_tsv"];
})();
const SERVICE_OWNED_ADDED = ["id", "title", "description", "request_type", "unit", "attachments", "comments", "metadata", "watchers",
  "search_keywords", "search_tsv", "target_completion_at", "sla_breach_warned_at", "sla_breached_at", "updated_at"];
const CLIENT_SHAPED = ["priority", "last_modified", "unread_by", "history"];
const guardedIn = (body: string) => [...body.matchAll(/IF NEW\.([a-z_]+)\s+IS DISTINCT FROM OLD\.\1\s+THEN v_bad := array_append\(v_bad, '\1'\); END IF;/g)].map((m) => m[1]);

describe("20261166 — ticket_update_guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (20261038 today — the scan, not this comment, decides)", () => {
    expect(guardDefiners).toContain(FILE);
    expect(GUARD_PREV < FILE).toBe(true);
    expect(GUARD_PREV >= "20261038_rp_phase4_ticket_workflow_rails.sql").toBe(true);
  });

  it("lineDiff: nothing of the base is removed; every added line is DF-P1's (three declarations, 15 service-owned columns, the history / unread_by / last_modified blocks)", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = code(onlyInB);
    const expected = [
      "  v_old_len INT;", "  v_email TEXT;", "  v_entry JSONB;",
      ...SERVICE_OWNED_ADDED.map((c) => `  IF NEW.${c.padEnd(27)} IS DISTINCT FROM OLD.${c.padEnd(27)} THEN v_bad := array_append(v_bad, '${c}'); END IF;`),
      "  v_old_len := jsonb_array_length(COALESCE(OLD.history, '[]'::jsonb));",
      "  IF COALESCE((SELECT jsonb_agg(h.value ORDER BY h.ordinality)",
      "                 FROM jsonb_array_elements(COALESCE(NEW.history, '[]'::jsonb)) WITH ORDINALITY AS h",
      "                WHERE h.ordinality <= v_old_len), '[]'::jsonb)",
      "     IS DISTINCT FROM COALESCE(OLD.history, '[]'::jsonb) THEN",
      "    RAISE EXCEPTION 'tickets: history entries cannot be changed — the log is append-only';",
      "  IF jsonb_array_length(COALESCE(NEW.history, '[]'::jsonb)) > v_old_len THEN",
      "    SELECT email INTO v_email FROM org_members",
      "     WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;",
      "    FOR v_entry IN SELECT h.value FROM jsonb_array_elements(NEW.history) WITH ORDINALITY AS h",
      "                    WHERE h.ordinality > v_old_len LOOP",
      "      IF (v_entry->>'user') IS DISTINCT FROM v_email",
      "         AND (v_entry->>'user') IS DISTINCT FROM auth.uid()::text THEN",
      "        RAISE EXCEPTION 'tickets: a history entry you add must name you';",
      "      END IF;",
      "    END LOOP;",
      "  IF NEW.unread_by IS DISTINCT FROM OLD.unread_by THEN",
      "    IF EXISTS (SELECT 1 FROM unnest(COALESCE(NEW.unread_by, '{}'::uuid[])) AS u(id)",
      "                WHERE NOT (u.id = ANY (COALESCE(OLD.unread_by, '{}'::uuid[])))) THEN",
      "      RAISE EXCEPTION 'tickets: unread_by is workflow-owned — you can only mark the request read for yourself';",
      "    NEW.unread_by := array_remove(COALESCE(OLD.unread_by, '{}'::uuid[]), auth.uid());",
      "  IF NEW.last_modified IS NULL AND OLD.last_modified IS NOT NULL THEN",
      "    RAISE EXCEPTION 'tickets: last_modified cannot be cleared';",
    ];
    // `END IF;` lines already exist in the base, so lineDiff (a set view) does
    // not list them as added; every other added line is exactly the expected set.
    expect(added.filter((l) => l.trim() !== "END IF;")).toEqual(expected.filter((l) => l.trim() !== "END IF;"));
  });

  it("the body minus DF-P1's three insertions IS the base, byte for byte (order and placement pinned)", () => {
    const decl = "  v_old_len INT;\n  v_email TEXT;\n  v_entry JSONB;\n";
    const colStart = G.next.indexOf("  -- DF-P1 (drafting-flow SM-2's census");
    const colEnd = G.next.indexOf("\n\n  IF array_length(v_bad, 1) > 0 THEN");
    const tailStart = G.next.indexOf("\n  -- DF-P1 (EVID-1 / AUTHZ-2 / PERS-1)");
    const tailEnd = G.next.indexOf("\n  RETURN NEW;\nEND;");
    expect(colStart).toBeGreaterThan(0);
    expect(tailStart).toBeGreaterThan(colStart);
    const cut = (G.next.slice(0, colStart) + G.next.slice(colEnd + 1, tailStart) + G.next.slice(tailEnd)).replace(decl, "");
    expect(cut).toBe(G.live);
  });

  it("SM-2 census: every one of the 41 tickets columns is decided — 37 refused to a client, four client-writable in a shape (priority, last_modified, unread_by, history)", () => {
    expect(TICKET_COLUMNS).toHaveLength(41);
    const guarded = guardedIn(G.next);
    expect(new Set(guarded).size).toBe(37);
    expect([...guarded, ...CLIENT_SHAPED].sort()).toEqual([...TICKET_COLUMNS].sort());
    expect(guarded).toEqual(expect.arrayContaining(["request_type", "unit", "metadata", "attachments", "comments", "watchers", "id", "title", "description"]));
    for (const c of CLIENT_SHAPED) expect(guarded, c).not.toContain(c);
    // the four shapes are decided in the body, not left open
    expect(G.next).toContain("RAISE EXCEPTION 'tickets: history entries cannot be changed — the log is append-only';");
    expect(G.next).toContain("NEW.unread_by := array_remove(COALESCE(OLD.unread_by, '{}'::uuid[]), auth.uid());");
    expect(G.next).toContain("IF NEW.last_modified IS NULL AND OLD.last_modified IS NOT NULL THEN");
    // priority stays free: the queue's mark-urgent writes it
    expect(G.next).not.toMatch(/NEW\.priority\b/);
  });

  it("LEAK-10 / LEAK-3 / AUTHZ-6: request_type and unit are workflow-owned (the whole DEC-13 resource)", () => {
    expect(guardedIn(G.next)).toEqual(expect.arrayContaining(["request_type", "unit"]));
    expect(src("lib/workflow.ts")).toContain("return { requestType: ticket.requestType || null, unit: ticket.unit || null };");
  });

  it("every column the body references is ADDed IF NOT EXISTS before the function (20261039's lesson); the trigger is restated; DRLS-16 revoke", () => {
    const before = M.slice(0, M.indexOf(GUARD_HEAD));
    for (const c of TICKET_COLUMNS.filter((x) => !["id", "org_id", "ticket_id", "status", "requester_id"].includes(x))) {
      expect(before, c).toMatch(new RegExp(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ${c} `));
    }
    expect(M).toContain("CREATE TRIGGER trg_ticket_update_guard\n  BEFORE UPDATE ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
  });
});

const RPC_HEAD = "CREATE OR REPLACE FUNCTION post_ticket_comment(";
const rpcDefiners = files.filter((f) => stripComments(mig(f)).includes(RPC_HEAD));
const RPC_PREV = rpcDefiners[rpcDefiners.indexOf(FILE) - 1];
const R = { live: between(mig(RPC_PREV), RPC_HEAD, "END$$;"), next: between(M, RPC_HEAD, "END$$;") };

describe("20261166 — post_ticket_comment re-created from its newest body (AUTHZ-8)", () => {
  it("the base is the newest earlier definition (20260810 today — found by scanning)", () => {
    expect(RPC_PREV).toBe("20260810_archive_invariants.sql");
  });

  it("lineDiff: only the two replaced array lines leave; the additions are the declarations, the identity stamp and the merged arrays", () => {
    const { onlyInA, onlyInB } = lineDiff(R.live, R.next);
    expect(onlyInA).toEqual([
      "         unread_by     = COALESCE(p_unread, unread_by),",
      "         watchers      = COALESCE(p_watchers, watchers),",
    ]);
    expect(code(onlyInB)).toEqual([
      "  v_email    TEXT;",
      "  v_role     TEXT;",
      "  v_roles    TEXT[];",
      "  v_author   UUID;",
      "  IF auth.uid() IS NOT NULL THEN",
      "    SELECT email, role, roles INTO v_email, v_role, v_roles FROM org_members",
      "     WHERE org_id = v_org AND uid = auth.uid() AND status = 'active' LIMIT 1;",
      "    p_comment := COALESCE(p_comment, '{}'::jsonb)",
      "                 || jsonb_build_object('authorUid', auth.uid(), 'user', v_email, 'role', v_role,",
      "                                       'roles', to_jsonb(COALESCE(v_roles, '{}'::text[])), 'date', NOW());",
      "  v_author := COALESCE(auth.uid(), (p_comment->>'authorUid')::uuid);",
      "         unread_by     = ARRAY(SELECT DISTINCT r.id",
      "                                 FROM unnest(COALESCE(unread_by, '{}'::uuid[]) || COALESCE(p_unread, '{}'::uuid[])) AS r(id)",
      "                                WHERE r.id IS DISTINCT FROM v_author),",
      "         watchers      = ARRAY(SELECT DISTINCT w.id",
      "                                 FROM unnest(COALESCE(watchers, '{}'::uuid[]) || COALESCE(p_watchers, '{}'::uuid[])) AS w(id)),",
    ]);
  });

  it("the archived-stub and membership checks survive; the stamp runs BEFORE the ticket_comments INSERT reads the payload", () => {
    expect(R.next).toContain("RAISE EXCEPTION 'ticket is archived; restore it before commenting';");
    expect(R.next).toContain("RAISE EXCEPTION 'not an active member of this org';");
    expect(R.next.indexOf("p_comment := COALESCE(p_comment")).toBeLessThan(R.next.indexOf("INSERT INTO ticket_comments"));
    expect(R.next).toContain("SECURITY DEFINER\nSET search_path = public");
  });

  it("EXECUTE: revoked from PUBLIC, anon AND authenticated on every overload; the service role keeps it — the comment route is the only caller", () => {
    expect(M).toContain("REVOKE EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) FROM PUBLIC, anon, authenticated;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) TO service_role;");
    expect(M).toContain("EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);");
    expect(M).toContain("EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);");
    // census: the only app caller is the comment route, under supabaseAdmin
    const callers: string[] = [];
    const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
    for (const f of ["app", "lib", "components", "hooks"].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f))) {
      if (/\.rpc\(\s*["']post_ticket_comment["']/.test(src(f))) callers.push(f);
    }
    expect(callers).toEqual(["app/api/tickets/comment/route.ts"]);
    expect(src("app/api/tickets/comment/route.ts")).toContain('await supabaseAdmin.rpc("post_ticket_comment", {');
  });
});

describe("20261166 — append_ticket_redline (SM-9 done-when 2)", () => {
  const HEAD = "CREATE OR REPLACE FUNCTION append_ticket_redline(";
  it("a new function (no earlier body to re-create from): SECURITY DEFINER, search_path pinned, a `||` append of one object each, service role only", () => {
    expect(files.filter((f) => f !== FILE && stripComments(mig(f)).includes(HEAD))).toEqual([]);
    const fn = between(M, HEAD, "END$$;");
    expect(fn).toContain("RETURNS BOOLEAN\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS $$");
    expect(fn).toContain("IF auth.uid() IS NOT NULL THEN\n    RAISE EXCEPTION 'append_ticket_redline: only the intake route, under the service key, may call this' USING ERRCODE = '42501';");
    expect(fn).toContain("SET attachments   = COALESCE(attachments, '[]'::jsonb) || jsonb_build_array(p_attachment),");
    expect(fn).toContain("history       = COALESCE(history, '[]'::jsonb) || jsonb_build_array(p_history),");
    expect(fn).toContain("WHERE id = p_ticket_id AND org_id = p_org_id AND archived_at IS NULL;");
    expect(M).toContain("REVOKE ALL ON FUNCTION append_ticket_redline(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION append_ticket_redline(UUID, UUID, JSONB, JSONB) TO service_role;");
    // census: the intake route is the only caller, under supabaseAdmin
    expect(src("app/api/intake/upload/route.ts")).toContain('await supabaseAdmin.rpc("append_ticket_redline", {');
  });
});

describe("20261166 — the policies (PERS-1 done-when 3, AUTHZ-13 / DEC-44 (DF-P1)) and the foreign key (PERS-4)", () => {
  const BASE_USING = "USING (org_id IN (SELECT my_org_ids()))";
  it("tickets_org_access (FOR ALL) is dropped and split per verb; every USING is the base expression byte for byte; every write half writes its check", () => {
    expect(src("supabase/schema.sql")).toContain(`CREATE POLICY "tickets_org_access" ON tickets FOR ALL\n  ${BASE_USING};`);
    expect(M).toContain('DROP POLICY IF EXISTS "tickets_org_access" ON tickets;');
    expect(M).toContain(`CREATE POLICY tickets_org_select ON tickets FOR SELECT\n  ${BASE_USING};`);
    expect(M).toContain("CREATE POLICY tickets_org_insert ON tickets FOR INSERT\n  WITH CHECK (org_id IN (SELECT my_org_ids()) AND requester_id = auth.uid());");
    expect(M).toContain(`CREATE POLICY tickets_org_update ON tickets FOR UPDATE\n  ${BASE_USING}\n  WITH CHECK (org_id IN (SELECT my_org_ids()));`);
    expect(M).toContain(`CREATE POLICY tickets_org_delete ON tickets FOR DELETE\n  ${BASE_USING};`);
    expect(stripComments(M)).not.toMatch(/CREATE POLICY[^;]*FOR ALL/);
    // no later numbered migration re-creates the blanket policy
    for (const f of files.filter((x) => x > FILE)) expect(stripComments(mig(f)), f).not.toMatch(/tickets_org_access/);
  });

  it("AUTHZ-13: a RESTRICTIVE SELECT on tickets and on ticket_comments for the authenticated role; the scope narrows ONLY a Contractor-only collection", () => {
    expect(M).toContain("CREATE POLICY tickets_read_scope ON tickets\n  AS RESTRICTIVE FOR SELECT TO authenticated\n  USING (ticket_read_scope_ok(org_id, id, requester_id, assigned_drafter_id, assigned_engineer_id, watchers));");
    expect(M).toContain("CREATE POLICY ticket_comments_read_scope ON ticket_comments\n  AS RESTRICTIVE FOR SELECT TO authenticated\n  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id));");
    const fn = between(M, "CREATE OR REPLACE FUNCTION ticket_read_scope_ok(", "\n$$;");
    expect(fn).toContain("LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("(CASE WHEN cardinality(m.roles) > 0 THEN m.roles ELSE ARRAY[m.role] END) <@ ARRAY['Contractor']::text[]");
    expect(fn).toContain("SELECT auth.uid() IS NOT NULL AND (");
    for (const leg of ["auth.uid() = p_requester", "auth.uid() = p_drafter", "auth.uid() = p_engineer", "auth.uid() = ANY (COALESCE(p_watchers, '{}'::uuid[]))", "auth.uid() = ANY (COALESCE(c.mentioned_uids, '{}'::uuid[]))"]) {
      expect(fn, leg).toContain(leg);
    }
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_read_scope_ok(uuid, uuid, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION ticket_read_scope_ok(uuid, uuid, uuid, uuid, uuid, uuid[]) TO authenticated, service_role;");
  });

  it("PERS-4: document_intents.ticket_id → tickets(id) ON DELETE CASCADE, in the two DEC-30 worlds; the restore's parent rule names it", () => {
    expect(M).toContain("FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE NOT VALID;");
    expect(M).toContain("FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;");
    expect(M).toMatch(/IF EXISTS \(SELECT 1 FROM document_intents i\s+WHERE i\.ticket_id IS NOT NULL\s+AND NOT EXISTS \(SELECT 1 FROM tickets t WHERE t\.id = i\.ticket_id\)\) THEN/);
    expect(src("lib/dataRestore.ts")).toContain('document_intents: fkRules("document_id>documents library_id>libraries base_version_id>document_versions ticket_id>tickets"),');
  });
});

describe("20261166 — DEC-30 one-paste shape", () => {
  it("prerequisite check → TEMP inventory BEFORE the transaction → BEGIN / COMMIT → ONE final SELECT (check, ok, n) with the inventory rows", () => {
    const pre = M.indexOf("RAISE EXCEPTION '20261166 needs 20261038");
    const temp = M.indexOf("CREATE TEMP TABLE df_round_g_166_before AS");
    const begin = M.indexOf("\nBEGIN;\n");
    const commit = M.indexOf("\nCOMMIT;\n");
    expect(pre).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(pre);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    expect(M.split("\nBEGIN;\n")).toHaveLength(2);
    expect(M.split("\nCOMMIT;\n")).toHaveLength(2);
    const tail = M.slice(commit);
    // one statement after COMMIT: the final SELECT, ending with the inventory union
    const outsideLiterals = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((outsideLiterals.match(/;/g) ?? []).length).toBe(2); // "COMMIT;" and the one SELECT
    expect(outsideLiterals.replace("COMMIT;", "").trim().startsWith("SELECT ")).toBe(true);
    expect(tail).toContain("AS check,");
    expect(tail).toContain("AS ok,\n       NULL::text AS n");
    expect(tail.trimEnd().endsWith("SELECT inventory, NULL::boolean, n FROM df_round_g_166_before;")).toBe(true);
    // inventory is aggregate-only
    const inv = M.slice(temp, begin);
    expect(inv).not.toMatch(/SELECT\s+\*/);
    expect((inv.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(8);
  });

  it("LEAK-10's read-only inventory is the record's query, counts only", () => {
    const inv = M.slice(M.indexOf("CREATE TEMP TABLE df_round_g_166_before AS"), M.indexOf("\nBEGIN;\n"));
    expect(inv).toContain("FROM org_configurations\n WHERE key = 'capability_policy'\n   AND (COALESCE(data -> 'caps' ->> 'ticket.engineer_gate_exempt', '') ~ '\"(requestType|unit)\"'\n     OR COALESCE(data -> 'caps' ->> 'ticket.direct_approve', '') ~ '\"(requestType|unit)\"')");
    const rec = src("audit-reports/drafting-flow/04-flow-leaks.md");
    expect(rec).toContain("WHERE key = 'capability_policy'\n  AND (COALESCE(data -> 'caps' ->> 'ticket.engineer_gate_exempt', '') ~ '\"(requestType|unit)\"'\n    OR COALESCE(data -> 'caps' ->> 'ticket.direct_approve', '') ~ '\"(requestType|unit)\"');");
  });

  it("probes: deparsed policy text is matched loosely (never a bare cast), prosrc apostrophes are doubled", () => {
    const tail = M.slice(M.indexOf("\nCOMMIT;\n"));
    expect(tail).toContain("with_check LIKE '%requester_id = auth.uid()%'");
    expect(tail).toContain("prosrc LIKE '%RAISE EXCEPTION ''tickets: the history log cannot shrink'';%'");
    expect(tail).not.toMatch(/qual LIKE '[^']*::/);
  });
});

describe("the client write census the guard was decided against (app/, lib/, components/, hooks/)", () => {
  it("every browser UPDATE of tickets touches only the four client-shaped columns; inserts are the three creators", () => {
    const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
    const updates: Array<{ f: string; cols: string[] }> = [];
    const inserts: string[] = [];
    for (const f of ["app", "lib", "components", "hooks"].flatMap(walk).filter((x) => /\.(ts|tsx)$/.test(x))) {
      const s = src(f);
      if (/supabaseAdmin|actor\.admin|asServiceRole/.test(s) && f.startsWith("app/api/")) continue; // service-role routes pass the guard
      for (const m of s.matchAll(/(?<![A-Za-z])supabase\s*\.from\(['"]tickets['"]\)\s*\.update\(\{([^}]*)\}/g)) {
        updates.push({ f, cols: [...m[1].matchAll(/([a-z_]+)\s*:/g)].map((x) => x[1]) });
      }
      if (/(?<![A-Za-z])supabase\s*\.from\(['"]tickets['"]\)\s*\.insert\(/.test(s)) inserts.push(f);
    }
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) for (const c of u.cols) expect(CLIENT_SHAPED, `${u.f}: ${c}`).toContain(c);
    expect(inserts.sort()).toEqual(["app/(protected)/requests/new/page.tsx", "components/documents/CheckInPanel.tsx", "lib/transitionIn.ts"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The routes
// ═════════════════════════════════════════════════════════════════════════════
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  onCall: null as null | ((table: string, method: string, args: unknown[]) => void),
  /** `${table}.${method}` → errors handed out one per call, in order. */
  errors: {} as Record<string, Array<{ code?: string; message: string } | null>>,
  r2: [] as Array<unknown>,
  rpcResult: { data: null, error: null } as { data: unknown; error: null | { code?: string; message: string } },
}));
function chain(table: string) {
  const filters: Array<[string, string, unknown]> = [];
  let head = false;
  let method: string | null = null;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([op, k, v]) =>
    op === "eq" ? r[k] === v : op === "is" ? (v === null ? r[k] == null : r[k] === v) : true)).map((r) => ({ ...r }));
  const errOf = () => (method ? state.errors[`${table}.${method}`]?.shift() ?? null : null);
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        const err = errOf();
        if (err) return resolve({ data: null, error: err });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (method === "insert") return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        state.onCall?.(table, prop, args);
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") method = prop;
        if (prop === "eq") filters.push(["eq", String(args[0]), args[1]]);
        if (prop === "is") filters.push(["is", String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const err = errOf() ?? (method === null ? state.errors[`${table}.select`]?.shift() ?? null : null);
          if (err) return Promise.resolve({ data: null, error: err });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (...args: unknown[]) => { state.calls.push({ table: "rpc", method: String(args[0]), args }); return state.rpcResult; }),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async (cmd: { input?: { Key?: string } }) => {
    state.calls.push({ table: "r2", method: "head", args: [cmd?.input?.Key] });
    const next = state.r2.length > 0 ? state.r2.shift() : { ContentLength: 1048576, ETag: '"etag-1"' };
    if (next instanceof Error) throw next;
    return next;
  }) },
  R2_BUCKET: "test-bucket",
}));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as commentPost } from "@/app/api/tickets/comment/route";
import { logAuditAction } from "@/lib/audit";
import { listMyNotifications, countUnread } from "@/lib/inAppNotifications";

const LM = "2026-10-02T00:00:00.000Z";
const req = (path: string, body: unknown) => new NextRequest(`http://app.local${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req("/api/tickets/workflow-action", body));
const member = (uid: string, role: string, roles = [role], over: Record<string, unknown> = {}) =>
  ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: null, status: "active", ...over });
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, ...over,
});
const KEY = (name: string) => `orgs/o1/tickets/REQ-1/1727000000000_${name}`;
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: KEY("iso_1A.pdf"), type: "Draft", status: "submitted", uploadedBy: "d-1@x.io" } as TicketAttachment;
const FINAL = { id: "a-f", name: "iso_IFC.pdf", url: KEY("iso_IFC.pdf"), type: "Final", status: "submitted", uploadedBy: "someone-else@x.io", size: "1 KB", uploadedAt: "2020-01-01T00:00:00.000Z" } as TicketAttachment;
const updatesOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const insertsOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Array<Record<string, unknown>>);
const ticketWrites = () => state.calls.filter((c) => c.table === "tickets" && ["update", "insert", "upsert", "delete"].includes(c.method));
const legsAfterFirst = (table: string, method: string) => {
  const i = state.calls.findIndex((c) => c.table === table && c.method === method);
  const out: Array<[string, string, unknown]> = [];
  for (const c of state.calls.slice(i + 1)) {
    if (c.table !== table) continue;
    if (c.method === "eq" || c.method === "is") out.push([c.method, String(c.args[0]), c.args[1]]);
    if (c.method === "select" || c.method === "maybeSingle") break;
  }
  return out;
};

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.onCall = null; state.errors = {}; state.r2 = [];
  state.rpcResult = { data: null, error: null };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  delete process.env.CRON_SECRET;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("AUTHZ-7 — a capability policy the route cannot read is a refusal, never the shipped defaults", () => {
  it("a policy read error is a 503 'policy_unreadable' with nothing written; a readable empty policy (nothing stored) still acts on the defaults", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow()];
    state.errors["org_configurations.select"] = [null, { message: "statement timeout" }]; // the drafting-config read, then the policy read
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "policy_unreadable" });
    expect(ticketWrites()).toHaveLength(0);
    expect(insertsOf("audit_logs")).toHaveLength(0);
    state.calls = [];
    const ok = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(ok.status).toBe(200);
  });

  it("the route reads through the strict loader and names its version in the audit row", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow()];
    state.rows.org_configurations = [{ org_id: "o1", key: "capability_policy", data: { caps: {} }, updated_at: "2026-10-01T09:00:00+00:00" }];
    expect((await post({ ticketId: "t1", actionType: "save_progress" })).status).toBe(200);
    const audit = insertsOf("audit_logs").find((a) => a.action === "TICKET_SAVE_PROGRESS")!;
    expect((audit.details as { authority: { policyVersion: string } }).authority.policyVersion).toBe("2026-10-01T09:00:00+00:00");
  });
});

describe("AUTHZ-11 / SM-13 — a file the route appends is vetted: this ticket's key, typed for its slot, in storage, stamped by the server", () => {
  const atFinal = () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter", ["Drafter"], { display_name: "Hector Drafts" }), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC", attachments: [DRAFT] })];
  };
  it("submit_final with a key under ANOTHER ticket, another org, a traversal or no prefix is a 400 with nothing written", async () => {
    atFinal();
    for (const url of ["orgs/o1/tickets/REQ-2/x.pdf", "orgs/o2/tickets/REQ-1/x.pdf", "orgs/o1/tickets/REQ-1/../REQ-2/x.pdf", "org/REQ-1/x.pdf", "orgs/o1/tickets/REQ-1/"]) {
      const res = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: { ...FINAL, url } });
      expect(res.status, url).toBe(400);
      expect((await res.json()).error).toMatch(/not stored under this request/);
    }
    expect(ticketWrites()).toHaveLength(0);
    expect(insertsOf("audit_logs")).toHaveLength(0);
    expect(state.calls.filter((c) => c.table === "r2")).toHaveLength(0); // refused before storage is asked
  });

  it("SM-13: a finalAttachment typed anything but Final is a 400 with the ticket still at PENDING_IFC", async () => {
    atFinal();
    for (const type of ["Reference", "Draft", "Source"]) {
      const res = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: { ...FINAL, type } });
      expect(res.status, type).toBe(400);
      expect((await res.json()).error).toMatch(/requires a file typed Final/);
    }
    expect(ticketWrites()).toHaveLength(0);
  });

  it("an object storage does not have is a 400; storage that cannot answer is a 503; neither writes", async () => {
    atFinal();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.r2 = [Object.assign(new Error("not found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })];
    const missing = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: FINAL });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/not in storage/);
    state.r2 = [Object.assign(new Error("socket hang up"), { name: "TimeoutError" })];
    const down = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: FINAL });
    expect(down.status).toBe(503);
    expect(ticketWrites()).toHaveLength(0);
  });

  it("a vetted Final lands with the server's uploader, time and size — the client's claims are not kept; the audit row names it", async () => {
    atFinal();
    state.r2 = [{ ContentLength: 2 * 1024 * 1024, ETag: '"abc123"' }];
    const res = await post({ ticketId: "t1", actionType: "submit_final", finalAttachment: FINAL });
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.table === "r2")?.args[0]).toBe(FINAL.url);
    const att = (updatesOf("tickets")[0].attachments as TicketAttachment[]).find((a) => a.id === "a-f")!;
    expect(att).toMatchObject({ url: FINAL.url, type: "Final", status: "submitted", uploadedBy: "d-1@x.io", size: "2.00 MB" });
    expect(att.uploadedAt).not.toBe(FINAL.uploadedAt);
    const audit = insertsOf("audit_logs").find((a) => a.action === "TICKET_SUBMIT_FINAL")!;
    expect(audit.details).toMatchObject({ finalAttachment: { id: "a-f", name: "iso_IFC.pdf", url: FINAL.url, size: "2.00 MB", etag: "abc123" } });
  });

  it("a redline is a Reference under this ticket's prefix; a 'redline' typed Final is refused", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", attachments: [DRAFT] })];
    const forged = await post({ ticketId: "t1", actionType: "request_revision", comment: "see markup", redlineAttachment: { ...FINAL, id: "r-1", name: "REDLINE_x.pdf" } });
    expect(forged.status).toBe(400);
    expect(ticketWrites()).toHaveLength(0);
    const ok = await post({ ticketId: "t1", actionType: "request_revision", comment: "see markup", redlineAttachment: { id: "r-2", name: "REDLINE_iso.pdf", url: KEY("REDLINE_iso.pdf"), type: "Reference", status: "submitted" } });
    expect(ok.status).toBe(200);
    expect((updatesOf("tickets")[0].attachments as TicketAttachment[]).map((a) => a.id)).toEqual(["a-d", "r-2"]);
  });

  it("a file already listed on the ticket needs no storage round-trip (and keeps its recorded uploader)", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: { ...DRAFT, id: "a-d2", type: "Reference" } });
    expect(res.status).toBe(200);
    expect(state.calls.filter((c) => c.table === "r2")).toHaveLength(0);
  });
});

describe("EVID-12 / SM-7 — the audit write is checked: retried once, then recorded on the ticket and reported, never 'ok' with a missing row", () => {
  const atReview = () => {
    state.user = { id: "e-1" };
    state.rows.org_members = [member("e-1", "Engineer-2"), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", requester_id: "e-1", attachments: [DRAFT], deliverable_rev: "1A" })];
  };
  it("a transient first failure is retried: one row lands, 200; the details carry the issued rev and the approved drafts", async () => {
    atReview();
    state.errors["audit_logs.insert"] = [{ message: "connection reset" }];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect(insertsOf("audit_logs").filter((a) => a.action === "TICKET_APPROVE_DRAFT_IFC")).toHaveLength(2); // the refused attempt + the retry
    const details = insertsOf("audit_logs").at(-1)!.details as Record<string, unknown>;
    expect(details).toMatchObject({ from: "PENDING_REVIEW", to: "PENDING_IFC", deliverable_rev: "1" });
    expect(details.approvedDrafts).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, size: null, etag: null }]);
  });

  it("a row that cannot be written: 500 'audit_unrecorded' (applied), and the ticket's history records the missing row, compare-and-set on the token just written", async () => {
    atReview();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.errors["audit_logs.insert"] = [{ message: "permission denied" }, { message: "permission denied" }];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "audit_unrecorded", applied: true, status: "PENDING_IFC" });
    const [transition, marker] = updatesOf("tickets");
    expect(transition.status).toBe("PENDING_IFC");
    const markerEntry = (marker.history as Array<Record<string, unknown>>).at(-1)!;
    expect(markerEntry).toMatchObject({ action: "Audit record not written", user: "system", auditUnrecorded: { action: "TICKET_APPROVE_DRAFT_IFC", from: "PENDING_REVIEW", to: "PENDING_IFC", actor: "e-1" } });
    expect((marker.history as unknown[]).slice(0, -1)).toEqual(transition.history);
    const i = state.calls.findIndex((c) => c.table === "tickets" && c.method === "update" && c.args[0] === marker);
    expect(state.calls.slice(i + 1, i + 3).map((c) => c.args)).toEqual([["id", "t1"], ["last_modified", transition.last_modified]]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("AUDIT ROW NOT WRITTEN"))).toBe(true);
  });

  it("the ticket_comments mirror is retried and then LOGGED with the ids (never swallowed); the transition itself stands", async () => {
    atReview();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.errors["ticket_comments.insert"] = [{ message: "boom" }, { message: "boom" }];
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "tag is wrong" });
    expect(res.status).toBe(200);
    expect(insertsOf("ticket_comments")).toHaveLength(2);
    expect(spy.mock.calls.some((c) => /ticket_comments mirror failed for comment .* on ticket t1/.test(String(c[0])))).toBe(true);
  });
});

describe("EVID-13 — retiring a stale alert is a MARK, never a read_at stamp", () => {
  it("a transition marks other recipients' unread workflow rows superseded (metadata) and never writes read_at", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ attachments: [{ ...DRAFT, status: "staged" }] })];
    state.rows.notifications = [
      { id: "n-1", org_id: "o1", user_id: "sup-1", resource_id: "t1", read_at: null, metadata: { action: "assign", status: "DRAFTING" } },
      { id: "n-2", org_id: "o1", user_id: "req-1", resource_id: "t1", read_at: "2026-10-01T00:00:00Z", metadata: { action: "assign", status: "DRAFTING" } },
    ];
    expect((await post({ ticketId: "t1", actionType: "submit_draft" })).status).toBe(200);
    const ups = updatesOf("notifications");
    expect(ups).toHaveLength(1);
    expect(ups[0]).not.toHaveProperty("read_at");
    expect(ups[0].metadata).toMatchObject({ action: "assign", status: "DRAFTING", superseded_by: "submit_draft" });
    const src_ = src("app/api/tickets/workflow-action/route.ts");
    expect(src_).not.toMatch(/\.update\(\{\s*read_at/);
  });

  it("the bell's unread list and count leave superseded rows out; the badge hook filters stale rows instead of marking them read", async () => {
    await listMyNotifications({ onlyUnread: true, orgId: "o1" }).catch(() => []);
    const isLegs = state.calls.filter((c) => c.table === "notifications" && c.method === "is").map((c) => c.args);
    expect(isLegs).toEqual(expect.arrayContaining([["read_at", null], ["metadata->>superseded_at", null]]));
    state.calls = [];
    await countUnread("o1").catch(() => 0);
    expect(state.calls.filter((c) => c.table === "notifications" && c.method === "is").map((c) => c.args))
      .toEqual(expect.arrayContaining([["read_at", null], ["metadata->>superseded_at", null]]));
    const hook = src("hooks/useTicketNotifications.ts");
    expect(hook).not.toContain("markManyRead");
    expect(hook).toContain("n = n.filter((r) => !staleSet.has(r.id));");
  });
});

describe("EDGE-9 — ticket emails carry absolute links", () => {
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  it("workflow-action: on the configured origin when set, else the request's own; no href starts with '/'", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ attachments: [{ ...DRAFT, status: "staged" }] })];
    process.env.NEXT_PUBLIC_SITE_URL = "https://ops.example.com/";
    expect((await post({ ticketId: "t1", actionType: "submit_draft" })).status).toBe(200);
    const [mail] = insertsOf("email_notifications");
    expect(hrefs(String(mail.body_html))).toEqual(["https://ops.example.com/requests/t1", "https://ops.example.com/requests/t1"]);
    expect(String(mail.body_text)).toContain("https://ops.example.com/requests/t1");
    // the in-app row stays an in-app (relative) link
    expect(insertsOf("notifications")[0].link).toBe("/requests/t1");
    state.calls = []; delete process.env.NEXT_PUBLIC_SITE_URL;
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", attachments: [DRAFT] })];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "x" })).status).toBe(200);
    for (const m of insertsOf("email_notifications")) for (const h of hrefs(String(m.body_html))) expect(h.startsWith("http://app.local/")).toBe(true);
  });

  it("comment route: the mention / watcher email links are absolute too", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow()];
    process.env.NEXT_PUBLIC_SITE_URL = "https://ops.example.com";
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "hello" }));
    expect(res.status).toBe(200);
    const mails = insertsOf("email_notifications");
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) {
      for (const h of hrefs(String(m.body_html))) expect(h).toMatch(/^https:\/\/ops\.example\.com\/requests\/t1\?c=/);
      expect(String(m.body_text)).toMatch(/https:\/\/ops\.example\.com\/requests\/t1\?c=/);
    }
    expect(insertsOf("notifications")[0].link).toMatch(/^\/requests\/t1\?c=/);
  });
});

describe("EDGE-15 — a row with no token compare-and-sets on the null itself", () => {
  it("the leg is .is('last_modified', null); two concurrent writes on a null-token row give one 200 and one 409", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ last_modified: null })];
    const first = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(first.status).toBe(200);
    expect(legsAfterFirst("tickets", "update")).toEqual([["eq", "id", "t1"], ["eq", "status", "DRAFTING"], ["is", "last_modified", null]]);
    // the second writer read the same null token; the first stamped it in between
    state.calls = [];
    state.onCall = (table, method) => { if (table === "tickets" && method === "update") state.rows.tickets[0].last_modified = "2026-10-02T00:00:05.000Z"; };
    const second = await post({ ticketId: "t1", actionType: "save_progress" });
    expect(second.status).toBe(409);
    expect(insertsOf("audit_logs")).toHaveLength(0);
  });
});

describe("SM-12 — the drafter's name on the row is the member's own, stamped server-side", () => {
  it("assign and reassign take org_members.display_name (else the email's local part), not the client's string; self_assign too", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"),
      member("d-1", "Drafter", ["Drafter"], { display_name: "Hector Ruiz" }), member("d-2", "Drafter", ["Drafter"], { display_name: null, email: "sam.lee@x.io" })];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    expect((await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "the CEO" } })).status).toBe(200);
    expect(updatesOf("tickets")[0]).toMatchObject({ assigned_drafter_id: "d-1", assigned_drafter_name: "Hector Ruiz" });
    expect((updatesOf("tickets")[0].history as Array<{ details?: string }>).at(-1)!.details).toBe("Assigned to Hector Ruiz");
    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "DRAFTING", assigned_drafter_id: "d-1" })];
    expect((await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "out", assignment: { id: "d-2", name: "forged" } })).status).toBe(200);
    expect(updatesOf("tickets")[0]).toMatchObject({ assigned_drafter_id: "d-2", assigned_drafter_name: "sam.lee" });
    state.calls = [];
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    expect((await post({ ticketId: "t1", actionType: "self_assign" })).status).toBe(200);
    expect(updatesOf("tickets")[0]).toMatchObject({ assigned_drafter_id: "d-1", assigned_drafter_name: "Hector Ruiz" });
  });
});

describe("SM-14 — the intent bridge reads the source document in the ticket's org", () => {
  it("a source document id from another workspace registers no intent; one in the ticket's org does, carrying its library and version", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.documents = [{ id: "foreign-doc", org_id: "o2", current_version_id: "v-x", library_id: "lib-x" }, { id: "doc-1", org_id: "o1", current_version_id: "v-1", library_id: "lib-1" }];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, metadata: { source_document: { id: "foreign-doc" } } })];
    expect((await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d" } })).status).toBe(200);
    expect(state.calls.filter((c) => c.table === "document_intents" && c.method === "upsert")).toHaveLength(0);
    const read = state.calls.findIndex((c) => c.table === "documents" && c.method === "select");
    expect(state.calls.slice(read + 1, read + 3).map((c) => c.args)).toEqual([["id", "foreign-doc"], ["org_id", "o1"]]);
    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, metadata: { source_document: { id: "doc-1" } } })];
    expect((await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d" } })).status).toBe(200);
    const up = state.calls.find((c) => c.table === "document_intents" && c.method === "upsert")!;
    expect(up.args[0]).toMatchObject({ document_id: "doc-1", library_id: "lib-1", base_version_id: "v-1", org_id: "o1" });
  });
});

describe("AUTHZ-14 — the gated requester's note to the engineer is required by the server", () => {
  it("request_final_engineer_approval without a note is a 400 with nothing written; with one it reaches PENDING_FINAL_APPROVAL carrying it", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2")];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", attachments: [DRAFT] })];
    for (const comment of [undefined, "", "   "]) {
      const res = await post({ ticketId: "t1", actionType: "request_final_engineer_approval", comment, engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/requires a note for the engineer/);
    }
    expect(ticketWrites()).toHaveLength(0);
    const ok = await post({ ticketId: "t1", actionType: "request_final_engineer_approval", comment: "check FE-201", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(ok.status).toBe(200);
    expect(updatesOf("tickets")[0]).toMatchObject({ status: "PENDING_FINAL_APPROVAL", engineer_review_reason: "check FE-201" });
  });
});

describe("DCW-4 / HAND-3 (DF-P1 limb) — a close believes a 'published' deliverable only when the register backs it", () => {
  const closing = (metadata: Record<string, unknown>) => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.documents = [{ id: "doc-1", org_id: "o1", rev: "3", document_number: "P-100" }];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", attachments: [FINAL], metadata })];
  };
  it("a hand-written 'published' state with no backing register version closes as NOT in the register — state, history line and note", async () => {
    closing({ source_document: { id: "doc-1", documentNumber: "P-100" }, deliverable: { state: "published", version_id: "not-a-real-version", revision_label: "9", document_id: "doc-1" } });
    const res = await post({ ticketId: "t1", actionType: "close_ticket" });
    expect(res.status).toBe(200);
    const upd = updatesOf("tickets")[0];
    expect((upd.metadata as { deliverable: Record<string, unknown> }).deliverable).toMatchObject({ state: "not_in_register", document_id: "doc-1", register_rev: "3" });
    expect((upd.history as Array<{ action: string; details?: string }>).at(-1)).toMatchObject({ action: "Closed — deliverable not in the register" });
    expect((upd.history as Array<{ details?: string }>).at(-1)!.details).toMatch(/could not be matched to a revision of P-100/);
    const read = state.calls.findIndex((c) => c.table === "document_versions" && c.method === "select");
    expect(state.calls.slice(read + 1, read + 5).map((c) => c.args)).toEqual([["id", "not-a-real-version"], ["org_id", "o1"], ["record_id", "doc-1"], ["related_ticket_id", "t1"]]);
  });

  it("a 'published' state the register backs (a version of the source, in this org, with this ticket as provenance) closes with no note", async () => {
    closing({ source_document: { id: "doc-1" }, deliverable: { state: "published", version_id: "v-9", revision_label: "4", document_id: "doc-1" } });
    state.rows.document_versions = [{ id: "v-9", org_id: "o1", record_id: "doc-1", related_ticket_id: "t1" }];
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    const upd = updatesOf("tickets")[0];
    expect(upd).not.toHaveProperty("metadata");
    expect((upd.history as Array<{ action: string }>).map((h) => h.action)).not.toContain("Closed — deliverable not in the register");
  });
});

describe("EDGE-11 diff-check — the load-bearing invariants still hold after DF-P1", () => {
  it("CAS on (id, status, last_modified) with a stamped token; archived stubs refused; service-role preference reads; PGRST202-only fallback", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow()];
    expect((await post({ ticketId: "t1", actionType: "save_progress" })).status).toBe(200);
    expect(legsAfterFirst("tickets", "update")).toEqual([["eq", "id", "t1"], ["eq", "status", "DRAFTING"], ["eq", "last_modified", LM]]);
    expect(updatesOf("tickets")[0].last_modified).not.toBe(LM);
    state.rows.tickets = [ticketRow({ archived_at: "2026-09-01T00:00:00Z" })];
    expect((await post({ ticketId: "t1", actionType: "save_progress" })).status).toBe(409);
    for (const route of ["app/api/tickets/comment/route.ts", "app/api/tickets/workflow-action/route.ts"]) {
      expect(src(route), route).toContain('supabaseAdmin.from("notification_preferences").select("*").in("user_id", recipients)');
    }
    // the comment route: an in-function error is a 500 (no fallback)
    state.calls = []; state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow()];
    state.rpcResult = { data: null, error: { code: "P0001", message: "rejected inside the function" } };
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "x" }))).status).toBe(500);
    expect(updatesOf("tickets")).toHaveLength(0);
  });

  it("the comment route's legacy write (RPC absent) MERGES unread_by like the RPC — it never drops a reader", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ unread_by: ["sup-1", "req-1"] })];
    state.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "x" }))).status).toBe(200);
    expect((updatesOf("tickets")[0].unread_by as string[]).sort()).toEqual(["d-1", "sup-1"]);
  });

  it("SM-9 done-when 3: the legacy whole-array write compare-and-sets on the token it read (the null token its own leg); a lost race is a 409, never a clobber", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    state.rows.tickets = [ticketRow()];
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "x" }))).status).toBe(200);
    expect(legsAfterFirst("tickets", "update")).toEqual([["eq", "id", "t1"], ["eq", "last_modified", LM]]);
    state.calls = [];
    state.rows.tickets = [ticketRow({ last_modified: null })];
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "y" }))).status).toBe(200);
    expect(legsAfterFirst("tickets", "update")).toEqual([["eq", "id", "t1"], ["is", "last_modified", null]]);
    // a workflow action stamps the row between this route's read and its write
    state.calls = [];
    state.rows.tickets = [ticketRow()];
    state.onCall = (table, method) => { if (table === "tickets" && method === "update") state.rows.tickets[0].last_modified = "2026-10-02T00:00:09.000Z"; };
    const lost = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "z" }));
    expect(lost.status).toBe(409);
    expect((await lost.json()).conflict).toBe(true);
    expect(insertsOf("notifications")).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. lib/audit.ts (EVID-6 / PERS-7)
// ═════════════════════════════════════════════════════════════════════════════
describe("EVID-6 / PERS-7 — logAuditAction reports a refused write and never sends a sentinel into the UUID column", () => {
  it("a refused insert is { ok: false, error } and logged with the action; a landed one is { ok: true }", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.errors["audit_logs.insert"] = [{ code: "42501", message: "new row violates row-level security policy" }];
    const bad = await logAuditAction({ action: "TICKET_FILE_UPLOAD", resourceId: "t1", resourceType: "ticket", orgId: "o1", userId: "u-1" });
    expect(bad).toEqual({ ok: false, error: "new row violates row-level security policy" });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("TICKET_FILE_UPLOAD"))).toBe(true);
    const good = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1", userId: "u-1" });
    expect(good).toEqual({ ok: true, error: null });
  });

  it("the '' / 'unknown' / 'system' stand-ins write user_id NULL and record the actor as system — a cron pass's row is durable under the service role", async () => {
    for (const userId of ["", "unknown", "system", "SYSTEM"]) {
      state.calls = [];
      await logAuditAction({ action: "REVIEW_ALTERNATE_ACTIVATED", resourceId: "d1", resourceType: "document", orgId: "o1", userId, metadata: { k: 1 } });
      const row = insertsOf("audit_logs")[0];
      expect(row.user_id, userId).toBeNull();
      expect(row.metadata).toMatchObject({ k: 1, actor_kind: "system" });
    }
    state.calls = [];
    await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1", userId: "u-1" });
    expect(insertsOf("audit_logs")[0]).toMatchObject({ user_id: "u-1", metadata: null });
  });
});
