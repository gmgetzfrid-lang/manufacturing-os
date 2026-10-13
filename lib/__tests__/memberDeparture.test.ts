// drafting-flow Round G, DF-P3 ROUTING — migration 20261195: tickets.outcome
// (LEAK-9 / GAP-107), ticket_update_guard re-created from its NEWEST body,
// the org_members departure triggers (EDGE-4) and the backlog moves (the
// drafterless REVISION_REQ stragglers, the stranded tickets).
//
// Shape tests (DEC-30's one-paste form) and the byte-fidelity lineDiff of the
// re-created guard against the newest earlier definition, found by SCANNING
// supabase/migrations at test time (a parallel re-creation folded in at merge
// is found the same way). The behaviour was exercised on a throwaway
// PostgreSQL 16 — the cases are recorded on EDGE-4 / LEAK-9.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TICKET_OUTCOMES } from "@/lib/ticketOutcome";
import { KIND_META } from "@/lib/notificationKinds";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261195_df_roundG_outcome_and_departure.sql";
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

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION ticket_update_guard()";
const guardDefiners = files.filter((f) => stripComments(mig(f)).includes(GUARD_HEAD));
const GUARD_PREV = guardDefiners[guardDefiners.indexOf(FILE) - 1];
const G = { live: between(mig(GUARD_PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const guardedIn = (body: string) => [...body.matchAll(/IF NEW\.([a-z_]+)\s+IS DISTINCT FROM OLD\.\1\s+THEN v_bad := array_append\(v_bad, '\1'\); END IF;/g)].map((m) => m[1]);

describe("20261195 — ticket_update_guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (20261166 today — the scan, not this comment, decides)", () => {
    expect(guardDefiners).toContain(FILE);
    expect(GUARD_PREV < FILE).toBe(true);
    expect(GUARD_PREV >= "20261166_df_roundG_ticket_rails.sql").toBe(true);
  });
  it("lineDiff: nothing of the base is removed; the added lines are exactly DF-P3's (the departure pass, the outcome column)", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB).filter((l) => l.trim() !== "END IF;")).toEqual([
      "  IF pg_trigger_depth() > 1",
      "     AND COALESCE(current_setting('app.ticket_departure', true), '') <> ''",
      "     AND current_setting('app.ticket_departure', true) IN (OLD.assigned_drafter_id::text, OLD.assigned_engineer_id::text) THEN",
      "    RETURN NEW;",
      `  IF NEW.${"outcome".padEnd(27)} IS DISTINCT FROM OLD.${"outcome".padEnd(27)} THEN v_bad := array_append(v_bad, 'outcome'); END IF;`,
    ]);
  });
  it("the body minus DF-P3's two insertions IS the base, byte for byte (order and placement pinned)", () => {
    const passStart = G.next.indexOf("\n  -- DF-P3 (drafting-flow EDGE-4)");
    const passEnd = G.next.indexOf("    RETURN NEW;\n  END IF;\n", passStart) + "    RETURN NEW;\n  END IF;\n".length;
    const outStart = G.next.indexOf("  -- DF-P3 (drafting-flow LEAK-9 / GAP-107)");
    const outEnd = G.next.indexOf("'outcome'); END IF;\n", outStart) + "'outcome'); END IF;\n".length;
    expect(passStart).toBeGreaterThan(0);
    expect(outStart).toBeGreaterThan(passEnd);
    // the pass sits right after the service-role pass, before any column is decided
    expect(G.next.slice(0, passStart).endsWith("IF auth.uid() IS NULL THEN RETURN NEW; END IF;\n")).toBe(true);
    const cut = G.next.slice(0, passStart + 1) + G.next.slice(passEnd + 1, outStart) + G.next.slice(outEnd);
    expect(cut).toBe(G.live);
  });
  it("every column 20261166 decided is still decided, and outcome joins them (38 refused to a client)", () => {
    const before = guardedIn(G.live);
    const after = guardedIn(G.next);
    expect(before.length).toBe(37);
    expect(after).toEqual(expect.arrayContaining([...before, "outcome"]));
    expect(new Set(after).size).toBe(38);
  });
  it("the departure pass is narrow: nested in a trigger, marked by THIS transaction, on a row the departing member held", () => {
    expect(G.next).toContain("IF pg_trigger_depth() > 1");
    expect(M).toContain("PERFORM set_config('app.ticket_departure', p_uid::text, true);");
    expect(M).toContain("PERFORM set_config('app.ticket_departure', '', true);");
    // the only writer of the mark is the departure function
    expect(M.match(/set_config\('app\.ticket_departure'/g)).toHaveLength(2);
    for (const f of files.filter((x) => x !== FILE)) expect(mig(f), f).not.toContain("set_config('app.ticket_departure'");
  });
  it("every re-creation of ticket_update_guard from 20261195 on keeps the departure pass (found by scanning) — without it member removals would leave tickets behind", () => {
    const fromHere = guardDefiners.filter((f) => f >= FILE);
    expect(fromHere[0]).toBe(FILE);
    for (const f of fromHere) {
      const body = between(mig(f), GUARD_HEAD, "\n$$;");
      expect(body, f).toContain("  IF pg_trigger_depth() > 1\n     AND COALESCE(current_setting('app.ticket_departure', true), '') <> ''\n     AND current_setting('app.ticket_departure', true) IN (OLD.assigned_drafter_id::text, OLD.assigned_engineer_id::text) THEN\n    RETURN NEW;\n  END IF;");
    }
  });
  it("the trigger is restated, DRLS-16 revoke kept, definer with search_path pinned", () => {
    expect(M).toContain("CREATE TRIGGER trg_ticket_update_guard\n  BEFORE UPDATE ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
  });
});

describe("20261195 — LEAK-9 / GAP-107: tickets.outcome", () => {
  it("the CHECK holds exactly lib/ticketOutcome.ts's vocabulary (or NULL)", () => {
    const check = between(M, "ADD CONSTRAINT tickets_outcome_check", "));");
    for (const o of TICKET_OUTCOMES) expect(check).toContain(`'${o}'`);
    expect(check.match(/'[a-z_]+'/g)).toHaveLength(TICKET_OUTCOMES.length);
    expect(check).toContain("outcome IS NULL OR outcome IN (");
    expect(M).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS outcome TEXT;");
  });
  it("the column is added before the guard that names it (a plpgsql body is late-bound)", () => {
    expect(M.indexOf("ADD COLUMN IF NOT EXISTS outcome TEXT")).toBeLessThan(M.indexOf(GUARD_HEAD));
  });
  it("the plan's sla_warned_at is NOT added (sla_breach_warned_at, 20260529, is that column)", () => {
    expect(stripComments(M)).not.toMatch(/\bsla_warned_at\b/);
    expect(M).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breach_warned_at TIMESTAMPTZ;");
  });
});

describe("20261195 — EDGE-4: the departure triggers", () => {
  const fn = between(M, "CREATE OR REPLACE FUNCTION return_departed_member_tickets(", "\n$$;");
  it("two SEPARATE triggers on org_members — AFTER UPDATE OF status (active → anything else) and AFTER DELETE", () => {
    expect(M).toContain("CREATE TRIGGER trg_org_member_departure_status\n  AFTER UPDATE OF status ON org_members\n  FOR EACH ROW\n  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')\n  EXECUTE FUNCTION org_member_departure_returns_tickets();");
    expect(M).toContain("CREATE TRIGGER trg_org_member_departure_delete\n  AFTER DELETE ON org_members\n  FOR EACH ROW\n  EXECUTE FUNCTION org_member_departure_returns_tickets();");
  });
  it("never a change to revoke_member: this file does not define it, and its NEWEST definition (found by scanning) does not carry the departure path", () => {
    expect(stripComments(M)).not.toContain("FUNCTION revoke_member");
    const defs = files.filter((f) => stripComments(mig(f)).includes("CREATE OR REPLACE FUNCTION revoke_member("));
    const newest = mig(defs[defs.length - 1]);
    expect(defs[defs.length - 1] >= "20261161_notif_roundG_read_scope.sql").toBe(true);
    expect(newest).not.toContain("return_departed_member_tickets");
  });
  it("hands back exactly what the ratified default says, never blocking the removal on a notice", () => {
    expect(fn).toContain("IF v_drafter AND v_status IN ('DRAFTING', 'REVISION_REQ') THEN\n      v_status := 'PENDING_ASSIGNMENT';");
    expect(fn).toContain("IF v_engineer AND v_t.status = 'PENDING_ENG_TEAM' THEN\n      v_status := 'PENDING_ASSIGNMENT';");
    expect(fn).toContain("ELSIF v_engineer AND v_t.status = 'PENDING_FINAL_APPROVAL' THEN\n      v_status := 'PENDING_REVIEW';");
    // a member still (or again) active departs nothing
    expect(fn).toContain("IF EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.uid = p_uid AND m.status = 'active') THEN\n    RETURN 0;");
    // the notice and the audit row are best-effort, each in its OWN sub-block:
    // a refused audit row never rolls the bell rows back
    expect(fn).toContain("          FROM unnest(v_tell) AS x(u);\n      END IF;\n    EXCEPTION WHEN OTHERS THEN\n      RAISE WARNING 'return_departed_member_tickets: ticket % was handed back, but its notice was not written: %', v_t.id, SQLERRM;\n    END;\n    BEGIN\n      INSERT INTO audit_logs");
    expect(fn).toContain("EXCEPTION WHEN OTHERS THEN\n      RAISE WARNING 'return_departed_member_tickets: ticket % was handed back, but its audit row was not written: %', v_t.id, SQLERRM;\n    END;\n    v_n := v_n + 1;");
    // the hand-back itself is guarded: a refusal (a later guard that dropped
    // the departure pass) is a WARNING and a skipped ticket, never a refused removal
    expect(fn).toContain("    BEGIN\n      UPDATE tickets t\n");
    expect(fn).toContain("       WHERE t.id = v_t.id;\n    EXCEPTION WHEN OTHERS THEN\n      v_skipped := v_skipped + 1;\n      RAISE WARNING 'return_departed_member_tickets: ticket % was NOT handed back");
    expect(fn).toContain("      CONTINUE;\n    END;");
    expect(fn).toContain("      BEGIN\n        DELETE FROM document_intents WHERE ticket_id = v_t.id AND user_id = p_uid AND source = 'ticket';\n      EXCEPTION WHEN OTHERS THEN");
    // nothing in the function writes outside a handler except the mark and the read
    expect(fn.match(/EXCEPTION WHEN OTHERS THEN/g)).toHaveLength(4);
    // fix pass 2: never a WAIT that the API's statement timeout could cancel —
    // a row another write holds is skipped, one call is bounded, and what it
    // leaves is counted in a WARNING (never silent, never a refusal)
    expect(fn).toContain("     ORDER BY t.created_at, t.id\n     LIMIT v_max\n     FOR UPDATE SKIP LOCKED\n  LOOP");
    expect(fn).toContain("  v_max      integer := 200;");
    expect(fn).not.toMatch(/FOR UPDATE\s*\n\s*LOOP/);
    expect(fn).toContain("  PERFORM set_config('app.ticket_departure', '', true);\n  -- What this call left on the departed member");
    expect(fn).toContain("SELECT COUNT(*) INTO v_left");
    expect(fn).toContain("RAISE WARNING 'return_departed_member_tickets: % ticket(s) of the departed member % in org % still name them");
    expect(fn).toContain("'ticket_status'");
    expect(fn).toContain("INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)\n      VALUES ('TICKET_RETURNED_ON_DEPARTURE'");
    // a history line in the 20261053 form, and the CAS token bumped
    expect(fn).toContain("'action', v_action, 'user', 'system', 'role', 'System',");
    expect(fn).toContain("last_modified                = now()");
  });
  it("the pool told is lib/ticketRouting.ts queuePool(): DraftingSupervisor holders (headline or collection), else Admins; both when the org says so", () => {
    expect(fn).toContain("WHERE btrim(h.r) = 'DraftingSupervisor');");
    expect(fn).toContain("WHERE btrim(h.r) = 'Admin');");
    expect(fn).toContain("(c.data -> 'routing' -> 'adminsAlsoReceiveWhenSupervisorSet') = 'true'::jsonb");
    expect(fn).toContain("v_pool := CASE WHEN cardinality(v_sup) = 0 THEN v_adm\n                 WHEN COALESCE(v_both, false) THEN v_sup || v_adm\n                 ELSE v_sup END;");
  });
  it("the bell rows' kind is declared in the NEWEST notification_kinds() (found by scanning) and in KIND_META", () => {
    const defs = files.filter((f) => stripComments(mig(f)).includes("CREATE OR REPLACE FUNCTION notification_kinds()"));
    const newest = between(mig(defs[defs.length - 1]), "CREATE OR REPLACE FUNCTION notification_kinds()", "$$;");
    expect(newest).toContain("('ticket_status',");
    expect(Object.keys(KIND_META)).toContain("ticket_status");
    expect(stripComments(M)).not.toContain("FUNCTION notification_kinds");
  });
  it("DRLS-16: both new functions are definers with search_path pinned; no client may execute either", () => {
    expect(M).toContain("CREATE OR REPLACE FUNCTION return_departed_member_tickets(p_org uuid, p_uid uuid, p_label text)\nRETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("CREATE OR REPLACE FUNCTION org_member_departure_returns_tickets()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION return_departed_member_tickets(uuid, uuid, text) FROM PUBLIC, anon, authenticated;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION return_departed_member_tickets(uuid, uuid, text) TO service_role;");
    expect(M).toContain("REVOKE ALL ON FUNCTION org_member_departure_returns_tickets() FROM PUBLIC, anon, authenticated, service_role;");
  });
});

describe("20261195 — DEC-30 one-paste shape", () => {
  it("prerequisite check → TEMP inventory (counts only) → BEGIN / COMMIT → one final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("RAISE EXCEPTION '20261195 needs 20261166");
    const inv = M.indexOf("CREATE TEMP TABLE df_round_g_195_before AS");
    const begin = M.indexOf("\nBEGIN;\n");
    const commit = M.indexOf("\nCOMMIT;\n");
    const final = M.indexOf("SELECT 'LEAK-9 / GAP-107: tickets.outcome exists");
    expect(pre).toBeGreaterThan(0);
    expect(inv).toBeGreaterThan(pre);
    expect(begin).toBeGreaterThan(inv);
    expect(commit).toBeGreaterThan(begin);
    expect(final).toBeGreaterThan(commit);
    expect(M.match(/\nBEGIN;\n/g)).toHaveLength(1);
    expect(M.match(/\nCOMMIT;\n/g)).toHaveLength(1);
    // the tail after COMMIT is ONE statement ending in the inventory rows
    const tail = stripComments(M.slice(commit + "\nCOMMIT;\n".length)).trim();
    const statementEnds = tail.split("\n").filter((l) => /;\s*$/.test(l));
    expect(statementEnds).toHaveLength(1);
    expect(tail.endsWith(";")).toBe(true);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM");
    expect(M).toContain("AS check,");
    expect(M).toContain("AS ok,\n       NULL::text AS n");
  });
  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = between(M, "CREATE TEMP TABLE df_round_g_195_before AS", "* 0.75 <= now();");
    const selects = inv.match(/SELECT \d+, '|SELECT 1 AS ord, '/g) ?? [];
    expect(selects.length).toBe(7);
    expect(inv.match(/COUNT\(\*\)::text/g)).toHaveLength(7);
  });
  it("the final SELECT carries 11 probes — and none that cannot fail (fix pass 2: the transaction-local departure mark read after COMMIT is gone; the function's own text is checked instead)", () => {
    const commit = M.indexOf("\nCOMMIT;\n");
    const tail = stripComments(M.slice(commit));
    expect(tail.match(/\n\s*NULL(::text AS n)?\n/g)).toHaveLength(11);
    expect(tail).not.toContain("COALESCE(current_setting('app.ticket_departure', true), '') = ''");
    expect(tail).toContain("prosrc LIKE '%PERFORM set_config(''app.ticket_departure'', p_uid::text, true);%END LOOP;%PERFORM set_config(''app.ticket_departure'', '''', true);%'");
    expect(M).toContain("-- Probes: ok = true × 11.");
  });
  it("the stragglers move with a history line and a bell row, and a probe checks none is left", () => {
    const moved = between(M, "-- (b) SM-6 / ROUTE-1", "END\n$$;");
    expect(moved).toContain("WHERE t.status = 'REVISION_REQ' AND t.assigned_drafter_id IS NULL AND t.archived_at IS NULL");
    expect(moved).toContain("SET status        = 'PENDING_ASSIGNMENT',");
    expect(moved).toContain("'action', 'Returned to the assignment queue', 'user', 'system', 'role', 'System',");
    expect(moved).toContain("INSERT INTO notifications");
    expect(M).toContain("SELECT 'SM-6 / ROUTE-1: no open REVISION_REQ ticket is left without a drafter',");
  });
  it("the stranded backlog is handed back through the same function — repeated until a call hands back none (one call is bounded) — and probes check none is left", () => {
    const backlog = between(M, "-- (a) open tickets already held by a uid", "END\n$$;");
    expect(backlog).toContain("v_n := return_departed_member_tickets(r.org_id, r.uid,");
    expect(backlog).toContain("EXIT WHEN COALESCE(v_n, 0) = 0 OR v_pass >= 1000;");
    expect(M).toContain("SELECT 'EDGE-4: no open ticket is left on a drafter who is not an active member of its org',");
    expect(M).toContain("SELECT 'EDGE-4: no PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL ticket waits on an engineer who is not an active member of its org',");
  });
  it("prosrc probes write an apostrophe inside a body's string literal as ''''", () => {
    expect(M).toContain("current_setting(''app.ticket_departure'', true) IN (OLD.assigned_drafter_id::text, OLD.assigned_engineer_id::text) THEN%'");
    expect(M).toContain("prosrc LIKE '%RAISE EXCEPTION ''tickets: the history log cannot shrink'';%'");
  });
  it("GAP-106 (fix pass 2): the SLA clock starts at the FIRST paste — the backlog past its target is stamped overdue without a notice each, and each workspace queue gets one summary bell row", () => {
    // the first-paste marker is read BEFORE the transaction adds the column
    const marker = M.indexOf("CREATE TEMP TABLE df_round_g_195_clock AS");
    expect(marker).toBeGreaterThan(M.indexOf("RAISE EXCEPTION '20261195 needs 20261166"));
    expect(marker).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    expect(M).toContain("SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns\n                    WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'outcome') AS first_paste;");
    const clock = between(M, "-- ── 5. GAP-106 / EDGE-7: the SLA clock starts at this paste", "END\n$$;");
    expect(clock.indexOf("\nCOMMIT;")).toBe(-1);
    expect(M.indexOf("-- ── 5. GAP-106 / EDGE-7")).toBeLessThan(M.indexOf("\nCOMMIT;\n"));
    expect(clock).toContain("IF NOT COALESCE((SELECT c.first_paste FROM df_round_g_195_clock c LIMIT 1), false) THEN\n    RETURN;");
    expect(clock).toContain("SET sla_breached_at      = now(),\n           sla_breach_warned_at = COALESCE(t.sla_breach_warned_at, now())");
    // the same "past its target" as lib/ticketSla.ts: its own target, else its org's sla_defaults window
    expect(clock).toContain("t.created_at + make_interval(days => d.default_days) < now()");
    expect(clock.match(/t\.target_completion_at < now\(\)/g)).toHaveLength(2);
    // nothing per ticket: no history line, no per-ticket bell row — one row per queue member per workspace
    expect(clock).not.toContain("history");
    expect(clock).toContain("'/requests', NULL, NULL, 'System',");
    expect(clock).toContain("jsonb_build_object('action', 'sla_clock_started', 'overdue', v_n)");
    expect(clock.match(/INSERT INTO notifications/g)).toHaveLength(1);
    // the app side: the scan sends nothing until this paste's column exists
    expect(readFileSync(join(process.cwd(), "lib", "ticketSla.ts"), "utf8")).toContain('export const SLA_CLOCK_MIGRATION = "20261195";\nexport const SLA_CLOCK_COLUMN = "outcome";');
    expect(M).toContain("SELECT 'GAP-106: the SLA clock started at the first paste");
  });
  it("the header states the paste and deploy order and names the merge obligations", () => {
    expect(M).toContain("DEPLOY THE DF-P3 APP FIRST, THEN\n-- PASTE THIS.");
    expect(M).toContain("admin-and-org P8 re-creates");
    expect(M).toContain("never re-paste 20261166 after this");
  });
});
