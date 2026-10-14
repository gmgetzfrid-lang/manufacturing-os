// drafting-flow Round G, DF-P12 DELIVERABLE FOLLOW-UPS.
//
//   SM-5 / EDGE-2 / PHYS-2  20261221: ticket_update_guard re-created from its
//            NEWEST body (found by scanning; lineDiff-pinned here) refuses a
//            client-appended "issued Rev N" line and stamps the history trust
//            index; the verdict trusts an issue line only at or after it — and
//            reads exactly as before without it (regression).
//   SM-5 dw3 / LEAK-7 (b)  the QR names the FILE (?a=): a print is told
//            apart by identity; a label issued twice cannot be confirmed by
//            label alone. Never greener.
//   EDGE-2 observation  a CLOSED ticket whose issued package was sent back
//            (reject_final) and force-closed scans "cannot confirm", not green
//            — on its issued label (any row), and, for a proven issue, after a
//            reopen (revision_count above N) or on a new review label (round N
//            recorded after the issue; 20261221's second limb). Review fix.
//   LEAK-7 (a)  20261222: the repair's DEC-30 shape (exercised at runtime in
//            lib/__tests__/rls/dfP12DeliverableRails.test.ts).
//   PHYS-17 / PHYS-8 dw3  20261223 + recordTicketCopy writes ticket_id /
//            attachment_id (falling back before the paste) + the stale-copies
//            ticket arm.
//   EVID-16  POST /api/tickets/copy stamps and records in the request that
//            issues the bytes; a refused record issues nothing.
//   Wording  the landing page says NOT ISSUED for a request that never issued
//            anything (an answered RFI), WITHDRAWN only after an issue.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import {
  ticketVerdict, ticketVerifyUrl, provenIssueFromHistory, provenSentBackAfterIssue, issueInForce, issuedMoreThanOnce, TICKET_ATTACHMENT_ID_RE,
} from "@/lib/verifyTicketVerdict";
import { ticketCopyPlan, ticketCopyStanding, recordTicketCopy, isMissingTicketCopyColumn } from "@/lib/ticketDeliverableCopy";
import { computeTransition } from "@/lib/ticketTransitions";
import type { Ticket, TicketHistoryEntry } from "@/types/schema";

// ─── harness: the service-role client, the anon verify client, the bucket ───
const st = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  ticketSelects: [] as string[],
  ticketSelectErrors: [] as Array<{ code?: string; message?: string } | null>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertErrors: {} as Record<string, Array<{ code?: string; message?: string } | null>>,
  recall: { data: null as unknown, error: null as null | { code?: string; message?: string } },
  recallFilters: [] as Array<[string, unknown]>,
  objects: {} as Record<string, Uint8Array>,
  r2Error: null as null | { name?: string; message?: string },
  user: { id: "u-drafter", email: "drafter@plant.test" } as { id: string; email: string } | null,
  mentions: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        const out = head ? { data: null, error: null, count: 0 }
          : table === "ticket_comments" ? { data: st.mentions, error: null }
          : table === "download_audits" ? st.recall
          : { data: null, error: null };
        return (resolve: (v: unknown) => void) => resolve(out);
      }
      return (...args: unknown[]) => {
        if (p === "select") {
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
          else if (table === "tickets") st.ticketSelects.push(String(args[0]));
        }
        if (table === "download_audits" && (p === "eq" || p === "gt")) st.recallFilters.push([String(args[0]), args[1]]);
        if (p === "insert") {
          st.inserts.push({ table, row: args[0] as Record<string, unknown> });
          const q = st.insertErrors[table];
          return Promise.resolve({ error: q && q.length ? q.shift() ?? null : null });
        }
        if (p === "maybeSingle") {
          if (table === "tickets") {
            const err = st.ticketSelectErrors.length ? st.ticketSelectErrors.shift() : null;
            return Promise.resolve(err ? { data: null, error: err } : { data: st.ticket, error: null });
          }
          if (table === "org_members") return Promise.resolve({ data: st.member, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (st.user ? { data: { user: st.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { input: { Key: string } }) => {
      if (st.r2Error) throw st.r2Error;
      const b = st.objects[cmd.input.Key];
      if (!b) throw { name: "NoSuchKey" };
      return { Body: { transformToByteArray: async () => b } };
    },
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Record<string, unknown>) => { st.emits.push(e); }) }));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { st.audits.push(e); return { ok: true, error: null }; }),
  logRevisionEvent: vi.fn(async () => {}),
}));

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ORIGIN = "https://plant.example.com";
const T = "77777777-7777-7777-7777-777777777777";
const ORG = "11111111-1111-1111-1111-111111111111";
const issued = (n: number) => ({ action: `Approve (Issue for Construction) — issued Rev ${n}`, user: "eng@plant.test" });
const forged = (n: number) => ({ action: `note — issued Rev ${n}`, user: "member@plant.test" });

// ═════════════════════════════════════════════════════════════════════════════
// 20261221 — the guard limb, lineDiff-pinned against the NEWEST earlier body
// ═════════════════════════════════════════════════════════════════════════════
const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
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
const oneFinalSelect = (M: string) => {
  const after = M.slice(M.indexOf("\nCOMMIT;\n"));
  return (stripComments(after).replace(/UNION ALL\s*\nSELECT/g, "UNION ALL SELECT").match(/^SELECT /gm) ?? []).length;
};

describe("20261221 — ticket_update_guard re-created from its NEWEST earlier body; the limb, the index, the insert reset", () => {
  const F = "20261221_df_roundG_issue_lines_server_only.sql";
  const M = mig(F);
  const GUARD = "CREATE OR REPLACE FUNCTION ticket_update_guard()";
  const definers = files.filter((f) => stripComments(mig(f)).includes(GUARD));
  const prev = definers[definers.indexOf(F) - 1];
  const live = between(mig(prev), GUARD, "\n$$;");
  const next = between(M, GUARD, "\n$$;");

  it("the base is the newest earlier definition (20261208 today — the scan decides)", () => {
    expect(definers).toContain(F);
    expect(prev < F).toBe(true);
    expect(prev >= "20261208_df_roundG_ticket_library.sql").toBe(true);
  });
  it("lineDiff: nothing of the base is removed; the added code lines are exactly the index (declared, stamped, owned) and the limb", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "  v_guarded_from_in INT := NEW.history_guarded_from;",
      "  IF OLD.history_guarded_from IS NULL AND NEW.history_guarded_from IS NULL",
      "     AND NOT (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL) THEN",
      "    NEW.history_guarded_from := CASE",
      "      WHEN OLD.archived_at IS NOT NULL THEN",
      "        CASE WHEN jsonb_typeof(NEW.history) = 'array' THEN jsonb_array_length(NEW.history) ELSE 0 END",
      "      ELSE",
      "        CASE WHEN jsonb_typeof(OLD.history) = 'array' THEN jsonb_array_length(OLD.history) ELSE 0 END",
      "    END;",
      "  IF v_guarded_from_in IS DISTINCT FROM OLD.history_guarded_from THEN v_bad := array_append(v_bad, 'history_guarded_from'); END IF;",
      "      IF COALESCE(v_entry->>'action', '') ~* 'issued Rev [[:digit:]]' THEN",
      "        RAISE EXCEPTION 'tickets: an \"issued Rev\" history entry is written only by the request workflow';",
      "      IF v_entry ? 'revisionRound' THEN",
      "        RAISE EXCEPTION 'tickets: a revision-round history entry is written only by the request workflow';",
    ]);
  });
  it("the body minus DF-P12's four insertions IS the base, byte for byte (order and placement pinned)", () => {
    const cut = (text: string, start: string, endAfter: string) => {
      const a = text.indexOf(start);
      const b = text.indexOf(endAfter, a) + endAfter.length;
      expect(a).toBeGreaterThan(0);
      return text.slice(0, a) + text.slice(b);
    };
    let t = next;
    t = cut(t, "  v_guarded_from_in INT := NEW.history_guarded_from;\n", "  v_guarded_from_in INT := NEW.history_guarded_from;\n");
    t = cut(t, "  -- DF-P12 (drafting-flow SM-5 / EDGE-2, 20261221): history_guarded_from is\n", "    END;\n  END IF;\n\n");
    t = cut(t, "  -- DF-P12 (drafting-flow SM-5 / EDGE-2, 20261221): the history trust index\n", "'history_guarded_from'); END IF;\n");
    t = cut(t, "      -- DF-P12 (drafting-flow SM-5 / EDGE-2 / PHYS-2, 20261221): an \"issued\n", "a revision-round history entry is written only by the request workflow';\n      END IF;\n");
    expect(t).toBe(live);
    // placements: the stamp precedes every early return; the limb sits in the append loop after "must name you"
    expect(next.indexOf("NEW.history_guarded_from := CASE")).toBeLessThan(next.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"));
    expect(next.indexOf("NEW.history_guarded_from := CASE")).toBeLessThan(next.indexOf("app.ticket_departure"));
    expect(next.indexOf("issued Rev [[:digit:]]")).toBeGreaterThan(next.indexOf("a history entry you add must name you"));
    expect(next.indexOf("IF v_entry ? 'revisionRound' THEN")).toBeGreaterThan(next.indexOf("issued Rev [[:digit:]]"));
    expect(next.indexOf("IF v_entry ? 'revisionRound' THEN")).toBeLessThan(next.indexOf("END LOOP;"));
    expect(next.indexOf("'history_guarded_from'); END IF;")).toBeLessThan(next.indexOf("IF array_length(v_bad, 1) > 0 THEN"));
  });
  it("every re-creation keeps the departure pass, library_id, outcome and the last_modified rule; DRLS-16 (definer, pinned, trigger restated, EXECUTE revoked)", () => {
    for (const must of ["app.ticket_departure", "v_bad := array_append(v_bad, 'library_id');", "array_append(v_bad, 'outcome'); END IF;", "tickets: last_modified cannot be cleared"]) expect(next).toContain(must);
    expect(next).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("CREATE TRIGGER trg_ticket_update_guard\n  BEFORE UPDATE ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;");
  });
  it("FOLDER SCAN: the NEWEST ticket_update_guard in the sequence keeps both limbs and the index stamp (a later re-creation that drops them must drop the index too)", () => {
    // A re-creation numbered after 20261221 that started from an older body
    // (20261208) would leave tickets.history_guarded_from vouching for lines
    // nobody guarded: provenIssueFromHistory would read a member's appended
    // "issued Rev N" as proof. Whatever file is newest must carry all three.
    const newest = definers.at(-1)!;
    const body = between(mig(newest), GUARD, "\n$$;");
    expect(body, newest).toContain("~* 'issued Rev [[:digit:]]'");
    expect(body, newest).toContain("IF v_entry ? 'revisionRound' THEN");
    expect(body, newest).toContain("NEW.history_guarded_from := CASE");
    expect(body, newest).toContain("array_append(v_bad, 'history_guarded_from')");
  });
  it("the limb is never narrower than the readers: every text the readers read as an issue line is refused", () => {
    const READER = /\bissued Rev (\d+)\b/;
    const LIMB = /issued Rev [0-9]/i; // the guard's ~* 'issued Rev [[:digit:]]'
    for (const s of ["Approve — issued Rev 2", "x issued Rev 12 y", "(issued Rev 3)", "issued Rev 4", "note,issued Rev 5"]) {
      expect(READER.test(s), s).toBe(true);
      expect(LIMB.test(s), s).toBe(true);
    }
    // wider: a case variant, and a run the readers' boundary rejects, are refused too
    expect(LIMB.test("ISSUED REV 2")).toBe(true);
    expect(LIMB.test("reissued Rev 2")).toBe(true);
  });
  it("the insert reset: SECURITY INVOKER, search_path pinned, BEFORE INSERT, EXECUTE revoked; the column is integer with a non-negative CHECK", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION ticket_history_guard_reset()", "\n$$;");
    expect(fn).toContain("RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$");
    expect(fn).not.toContain("SECURITY DEFINER");
    expect(fn).toContain("NEW.history_guarded_from := NULL;");
    expect(M).toContain("CREATE TRIGGER trg_ticket_history_guard_reset\n  BEFORE INSERT ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_history_guard_reset();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_history_guard_reset() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS history_guarded_from INTEGER;");
    expect(M).toContain("CHECK (history_guarded_from IS NULL OR history_guarded_from >= 0)");
    // the column exists before the guard that reads it
    expect(M.indexOf("ADD COLUMN IF NOT EXISTS history_guarded_from")).toBeLessThan(M.indexOf(GUARD));
  });
  it("DEC-30 shape: prerequisite refusal, counts-only inventory BEFORE the transaction, BEGIN/COMMIT, ONE final SELECT (check, ok, n)", () => {
    expect(M.indexOf("RAISE EXCEPTION '20261221 needs 20261208")).toBeLessThan(M.indexOf("CREATE TEMP TABLE df_round_g_221_before"));
    expect(M.indexOf("CREATE TEMP TABLE df_round_g_221_before")).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    expect(M.indexOf("\nBEGIN;\n")).toBeLessThan(M.indexOf("\nCOMMIT;\n"));
    expect(oneFinalSelect(M)).toBe(1);
    const after = M.slice(M.indexOf("\nCOMMIT;\n"));
    for (const s of ["AS check,", "AS ok,", "NULL::text AS n"]) expect(after).toContain(s);
    const inv = between(M, "CREATE TEMP TABLE df_round_g_221_before", "\nBEGIN;");
    expect((inv.match(/COUNT\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(inv).not.toMatch(/SELECT\s+t\.(id|title|history|requester_name)\b/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 20261222 / 20261223 — shapes (runtime: lib/__tests__/rls/dfP12DeliverableRails.test.ts)
// ═════════════════════════════════════════════════════════════════════════════
describe("20261222 — the LEAK-7 (a) repair: counts first, one UPDATE, one result set", () => {
  const M = mig("20261222_df_roundG_leak7_reopened_label_repair.sql");
  it("inventory before the transaction (counts only: (a), left alone, (a′), (b), (c)); one UPDATE limited to (a) rows; ONE final SELECT", () => {
    expect(M.indexOf("CREATE TEMP TABLE df_round_g_222_before")).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    expect(oneFinalSelect(M)).toBe(1);
    const inv = between(M, "CREATE TEMP TABLE df_round_g_222_before", "\nBEGIN;");
    expect((inv.match(/'inventory \(before apply\): /g) ?? []).length).toBe(5);
    expect(inv).not.toMatch(/SELECT\s+t\.(id|title|history|requester_name)\b/);
    const tx = between(M, "\nBEGIN;\n", "\nCOMMIT;\n");
    expect((stripComments(tx).match(/\bUPDATE\b/g) ?? []).length).toBe(1);
    expect(tx).toContain("WHERE t.status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')\n   AND t.deliverable_rev ~ '^[0-9]{1,6}$'\n   AND t.archived_at IS NULL");
    // exactly reopen_ticket's counters (WF-21 / DEC-15), never a skipped number
    expect(tx).toContain("revision_count  = GREATEST(COALESCE(t.revision_count, 0), t.deliverable_rev::int)");
    expect(tx).toContain("deliverable_rev = NULL");
    expect(tx).toContain("draft_iteration = 0");
    // the repair line is never read as an issue line, by the readers or the guard
    const line = between(tx, "'action', '", "',");
    expect(/\bissued Rev (\d+)\b/.test(line)).toBe(false);
    expect(/issued Rev [0-9]/i.test(tx)).toBe(false);
    expect(stripComments(M)).not.toMatch(/CREATE (OR REPLACE )?FUNCTION|CREATE POLICY|CREATE TRIGGER/);
  });
});

describe("20261223 — download_audits.ticket_id / attachment_id (PHYS-17)", () => {
  const M = mig("20261223_df_roundG_download_audits_ticket_copy.sql");
  it("two plain nullable columns (no foreign key), an index, the permissive policies untouched; prerequisite 20261068; DEC-30 shape", () => {
    const tx = between(M, "\nBEGIN;\n", "\nCOMMIT;\n");
    expect(tx).toContain("ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS ticket_id UUID;");
    expect(tx).toContain("ALTER TABLE download_audits ADD COLUMN IF NOT EXISTS attachment_id TEXT;");
    expect(stripComments(tx)).not.toMatch(/REFERENCES/);
    // the only policy statement is the RESTRICTIVE read scope (it narrows; nothing permissive is created or dropped)
    const policyStmts = stripComments(tx).match(/(CREATE|DROP|ALTER) POLICY[^;]*;/g) ?? [];
    expect(policyStmts.map((x) => x.replace(/\s+/g, " "))).toEqual([
      "DROP POLICY IF EXISTS download_audits_ticket_read_scope ON download_audits;",
      "CREATE POLICY download_audits_ticket_read_scope ON download_audits AS RESTRICTIVE FOR SELECT TO authenticated USING (ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = download_audits.ticket_id));",
    ]);
    expect(M.indexOf("RAISE EXCEPTION '20261223 needs 20261068")).toBeLessThan(M.indexOf("CREATE TEMP TABLE df_round_g_223_before"));
    expect(oneFinalSelect(M)).toBe(1);
    // counts only before the transaction: the rows the narrowing affects and the callers it narrows
    const inv = between(M, "CREATE TEMP TABLE df_round_g_223_before", "\nBEGIN;");
    expect((inv.match(/'inventory \(before apply\): /g) ?? []).length).toBe(5);
    expect(inv).toContain("to_jsonb(d) ->> 'ticket_id' IS NOT NULL");
    // the probe reads the DEPARSED qual (no cast inside a LIKE pattern)
    const after = M.slice(M.indexOf("\nCOMMIT;\n"));
    expect(after).toContain("permissive = 'RESTRICTIVE'");
    expect(after).toContain("qual LIKE '%t.id = download_audits.ticket_id%'");
    expect(after).not.toMatch(/LIKE '[^']*::[^']*'/);
  });
  it("the source comment restates every channel 20261068 named and adds the two unstamped drafting channels the app writes", () => {
    const old = between(mig("20261068_dc_roundF_download_audits_record.sql"), "COMMENT ON COLUMN download_audits.source IS", "';\n");
    const next = between(M, "COMMENT ON COLUMN download_audits.source IS", "';\n");
    for (const v of ["share_link", "share_link_unstamped", "transmittal_portal", "drafting", "drafting_print"]) {
      expect(old).toContain(v);
      expect(next).toContain(v);
    }
    for (const v of ["drafting_unstamped", "drafting_print_unstamped"]) expect(next).toContain(v);
    // the comment is the newest one across the sequence
    const commenters = files.filter((f) => stripComments(mig(f)).includes("COMMENT ON COLUMN download_audits.source IS"));
    expect(commenters.at(-1)).toBe("20261223_df_roundG_download_audits_ticket_copy.sql");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The verdict — regression first, then the guard's trust, identity, (b), rework
// ═════════════════════════════════════════════════════════════════════════════
const actor = { uid: "a-1", email: "a@x.io", role: "Admin" };
const NOW = "2026-10-14T12:00:00.000Z";
type Row = { status: string; deliverable_rev: string | null; revision_count: number; draft_iteration: number; history: TicketHistoryEntry[] };
const toTicket = (r: Row) => ({ id: T, orgId: "o", ticketId: "KE-1", title: "x", unit: "U", requestType: "ISO", requesterId: "u", requesterRole: "Viewer",
  attachments: [], comments: [], unreadBy: [], watchers: [], createdAt: NOW, assignedDrafterId: "d",
  status: r.status, deliverableRev: r.deliverable_rev, revisionCount: r.revision_count, draftIteration: r.draft_iteration, history: r.history }) as unknown as Ticket;
const step = (r: Row, actionType: string, actionLabel: string): Row => {
  const t = computeTransition(toTicket(r), { actionType, actionLabel, actor, now: NOW } as Parameters<typeof computeTransition>[1]);
  const u = t.updates as Record<string, unknown>;
  return {
    status: t.newStatus ?? r.status,
    deliverable_rev: "deliverable_rev" in u ? (u.deliverable_rev as string | null) : r.deliverable_rev,
    revision_count: "revision_count" in u ? (u.revision_count as number) : r.revision_count,
    draft_iteration: "draft_iteration" in u ? (u.draft_iteration as number) : r.draft_iteration,
    history: [...r.history, t.historyEntry as TicketHistoryEntry],
  };
};

describe("REGRESSION — a legitimately issued, current deliverable scans current and prints exactly as after DF-P10, with or without the file's id", () => {
  it("Rev 1 issued through the workflow: current at PENDING_IFC / FINAL_DRAFT / CLOSED; the plan is DF-P10's plus ?a=", () => {
    let r: Row = { status: "DRAFTING", deliverable_rev: null, revision_count: 0, draft_iteration: 0, history: [] };
    r = step(r, "submit_draft", "Submit for Review");
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)");
    const files = [{ id: "f-1", type: "Final", rev: "1" }];
    for (const s of [r, step(r, "submit_final", "Submit Final"), step(step(r, "submit_final", "Submit Final"), "close_ticket", "Close")]) {
      for (const guardedFrom of [undefined, null, 0, 1, 99]) {
        const row = { ...s, attachments: files, history_guarded_from: guardedFrom };
        expect(ticketVerdict(row, "1").verdict, `${s.status} ${guardedFrom}`).toBe("current");
        expect(ticketVerdict(row, "1", "f-1").verdict, `${s.status} ${guardedFrom} a`).toBe("current");
      }
      const plan = ticketCopyPlan({ file: { id: "f-1", type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: { status: s.status, deliverableRev: s.deliverable_rev, history: s.history, revisionCount: s.revision_count } });
      expect([plan.standing, plan.confirmMessage]).toEqual([null, null]);
      expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}?r=1&a=f-1`);
      expect(plan.footerNotice).toBe("This file is KE-1 deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    }
  });
  it("a row with no trust index reads EXACTLY as before 20261221 (the pre-paste reading is DF-P10's, pinned by verifyTicketVerdict.test.ts)", () => {
    const reclosed = { status: "CLOSED", deliverable_rev: null, history: [issued(1), issued(2), { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }], revision_count: 2 };
    expect(ticketVerdict(reclosed, "2").verdict).toBe("unknown");
    expect(ticketVerdict({ ...reclosed, history_guarded_from: null }, "2").verdict).toBe("unknown");
    // issue 3 (DF-P10's recorded residual): a forged line under a review label still supersedes a real issue when nothing is proven
    const issue3 = { status: "PENDING_REVIEW", deliverable_rev: "3A", revision_count: 2, history: [issued(1), { action: "Reject Final" }, { action: "Submitted for review — Rev 2A" }, { action: "Reject" }, { action: "Submitted for review — Rev 3A" }, forged(2)] };
    expect(ticketVerdict(issue3, "1").verdict).toBe("superseded");
  });
});

describe("SM-5 guard limb — after 20261221, an issue line at or after the row's index is the workflow's, and the fail-safe rules lift for it", () => {
  it("provenIssueFromHistory reads only lines at or after the index, never above the caps; no index → null", () => {
    const h = [issued(1), forged(5), issued(2)];
    expect(provenIssueFromHistory(h, 2, 1, "2")).toBe("2");
    expect(provenIssueFromHistory(h, 0, 1, "2")).toBe(null); // the forged 5 sits in the proven region: above the caps → inconsistent, read as before
    expect(provenIssueFromHistory(h, 3, 1, "2")).toBe(null);
    for (const g of [undefined, null, -1, 1.5]) expect(provenIssueFromHistory(h, g as number, 1, "2")).toBe(null);
    expect(issueInForce([issued(1), forged(2), issued(3)], 2, "3", 2)).toBe("3");
    expect(issueInForce([issued(1)], 0, "1", undefined)).toBe("1");
  });
  it("ruling 1 lifted: a ticket reopened and force-closed after a PROVEN issue reads the ladder on it — current for it, superseded for older", () => {
    const row = { status: "CLOSED", deliverable_rev: null, revision_count: 2, history_guarded_from: 1,
      history: [issued(1), issued(2), { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }] };
    expect(ticketVerdict(row, "2")).toMatchObject({ verdict: "current", latestIssuedRev: "2", inReview: false });
    expect(ticketVerdict(row, "1").verdict).toBe("superseded");
    expect(ticketVerdict(row, "3A").verdict).toBe("draft_copy");
    expect(ticketVerdict(row, "").verdict).toBe("unknown");
    // the same history with its issues all BEFORE the index stays "cannot confirm"
    expect(ticketVerdict({ ...row, history_guarded_from: 2 }, "2").verdict).toBe("unknown");
  });
  it("issue 3 closed: once a ticket has a proven issue, an earlier line claiming a higher number can no longer supersede it", () => {
    // a member appended "issued Rev 2" before the paste; Rev 1 was issued after it (proven, index 1)
    const row = { status: "PENDING_REVIEW", deliverable_rev: "3A", revision_count: 2, history_guarded_from: 1,
      history: [forged(2), issued(1), { action: "Reject Final" }, { action: "Submitted for review — Rev 2A" }, { action: "Reject" }, { action: "Submitted for review — Rev 3A" }] };
    expect(ticketVerdict(row, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1" });
    expect(ticketVerdict(row, "2").verdict).not.toBe("current");
    // the copy follows: no SUPERSEDED stamp on the real Rev 1
    expect(ticketCopyStanding("1", { status: row.status, deliverableRev: row.deliverable_rev, history: row.history, revisionCount: 2, historyGuardedFrom: 1 })).toEqual({ kind: "in_progress" });
    expect(ticketCopyStanding("1", { status: row.status, deliverableRev: row.deliverable_rev, history: row.history, revisionCount: 2 })).toEqual({ kind: "superseded", by: "2" });
  });
  it("a set-aside line is never ambiguity on a proven ticket (it is provably not an approval's)", () => {
    // a member appended "issued Rev 2" before the paste (index 0); Rev 1 was issued after it (index 1, proven); 2A was submitted, then force-closed
    const row = { status: "CLOSED", deliverable_rev: "2A", revision_count: 1, history_guarded_from: 1, history: [forged(2), issued(1), { action: "Submitted for review — Rev 2A" }] };
    // without the index the forged 2 (above the label's bound) is set aside and the row is "cannot confirm" (DF-P10's ruling 2); with it, Rev 1 is proven and stands
    expect(ticketVerdict({ ...row, history_guarded_from: null }, "1").verdict).toBe("unknown");
    expect(ticketVerdict(row, "1")).toMatchObject({ verdict: "current", latestIssuedRev: "1" });
  });
});

describe("SM-5 done-when 3 / LEAK-7 (b) — the printed file's identity on the QR", () => {
  const atIfc = (attachments: unknown, history: unknown[] = [issued(1)]) => ({ status: "PENDING_IFC", deliverable_rev: "1", revision_count: 0, history, attachments });
  it("ticketVerifyUrl carries ?a= only for an id of the accepted shape; the plan passes the file's id", () => {
    expect(ticketVerifyUrl(ORIGIN, T, "1", "0f7a-uuid_like")).toBe(`${ORIGIN}/verify-ticket/${T}?r=1&a=0f7a-uuid_like`);
    expect(ticketVerifyUrl(ORIGIN, T, null, "f-1")).toBe(`${ORIGIN}/verify-ticket/${T}?a=f-1`);
    expect(ticketVerifyUrl(ORIGIN, T, "1", "../x")).toBe(`${ORIGIN}/verify-ticket/${T}?r=1`);
    expect(ticketVerifyUrl(ORIGIN, T, "1", "x".repeat(65))).toBe(`${ORIGIN}/verify-ticket/${T}?r=1`);
    expect(TICKET_ATTACHMENT_ID_RE.test("6f1c2a9e-0d3b-4c8e-9a7f-1b2c3d4e5f60")).toBe(true);
  });
  it("a file that is this ticket's, once, at the printed revision confirms; anything else demotes green / amber to 'cannot confirm' — never red", () => {
    expect(ticketVerdict(atIfc([{ id: "f-1", type: "Final", rev: "1" }]), "1", "f-1").verdict).toBe("current");
    expect(ticketVerdict(atIfc([{ id: "f-1", type: "Final", rev: "1" }]), "1", "nope").verdict).toBe("unknown");
    expect(ticketVerdict(atIfc([{ id: "f-1", rev: "1" }, { id: "f-1", rev: "1" }]), "1", "f-1").verdict).toBe("unknown");
    expect(ticketVerdict(atIfc([{ id: "f-1", type: "Final", rev: null }]), "1", "f-1").verdict).toBe("unknown");
    expect(ticketVerdict(atIfc(null), "1", "f-1").verdict).toBe("unknown");
    // red stays red: a superseded print naming a file of another revision is still superseded
    const atRev2 = { status: "PENDING_IFC", deliverable_rev: "2", revision_count: 1, history: [issued(1), issued(2)], attachments: [{ id: "f-2", rev: "2" }] };
    expect(ticketVerdict(atRev2, "1", "f-2").verdict).toBe("superseded");
    // amber confirmed stays amber
    const rework = { status: "REVISION_REQ", deliverable_rev: "1", revision_count: 1, history: [issued(1)], attachments: [{ id: "f-1", rev: "1" }] };
    expect(ticketVerdict(rework, "1", "f-1").verdict).toBe("revision_in_progress");
  });
  it("LEAK-7 (b): a label issued twice — an old print naming only the label cannot be told apart (never green); a print carrying a confirmed identity can", () => {
    const twice = atIfc([{ id: "f-new", type: "Final", rev: "1" }], [issued(1), { action: "Reopen Ticket" }, issued(1)]);
    expect(issuedMoreThanOnce(twice.history, 0, "1")).toBe(true);
    expect(ticketVerdict(twice, "1").verdict).toBe("unknown");
    expect(ticketVerdict(twice, "1", "f-new").verdict).toBe("current");
    expect(ticketVerdict({ ...twice, status: "REVISION_REQ" }, "1").verdict).toBe("unknown");
    // a line above revision_count + 1 never counts toward a duplicate
    expect(issuedMoreThanOnce([issued(3), issued(3)], 0, "3")).toBe(false);
    // once issued, never twice: an ordinary row is untouched
    expect(ticketVerdict(atIfc([], [issued(1)]), "1").verdict).toBe("current");
  });
});

describe("EDGE-2's observation — reject_final then Force Close on the issued label: the rejected package does not scan green (decided fail-safe, DEC-90)", () => {
  it("walked through the workflow: Rev 1 issued, final submitted, rejected, force-closed → print of Rev 1 'cannot confirm'; a normal close stays current", () => {
    let r: Row = { status: "PENDING_REVIEW", deliverable_rev: "1A", revision_count: 0, draft_iteration: 1, history: [] };
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)");
    r = step(r, "submit_final", "Submit Final");
    const normal = step(r, "close_ticket", "Close");
    expect([normal.status, normal.deliverable_rev, normal.revision_count]).toEqual(["CLOSED", "1", 0]);
    expect(ticketVerdict(normal, "1").verdict).toBe("current");
    const rejected = step(r, "reject_final", "Reject Final");
    expect([rejected.deliverable_rev, rejected.revision_count]).toEqual(["1", 1]);
    const forced = step(rejected, "close_ticket", "Force Close (Admin)");
    expect([forced.status, forced.deliverable_rev]).toEqual(["CLOSED", "1"]);
    expect(ticketVerdict(forced, "1").verdict).toBe("unknown");
    expect(ticketVerdict(forced, "1A").verdict).toBe("draft_copy");
    // an older issue on such a row stays red
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "2", revision_count: 2, history: [issued(1), issued(2)] }, "1").verdict).toBe("superseded");
  });
});

describe("DEC-44 (DF-P12) item 2 after 20261221 — a package sent back after its PROVEN issue does not scan green, whichever label the ticket closes on (review fix)", () => {
  // Rev 1 issued after the paste: the trust index is the history length before the issue (0 here).
  const issuedAfterPaste = (): Row => step({ status: "PENDING_REVIEW", deliverable_rev: "1A", revision_count: 0, draft_iteration: 1, history: [] }, "approve_draft_ifc", "Approve (Issue for Construction)");
  const withIndex = (r: Row, g: number | null = 0) => ({ ...r, history_guarded_from: g });
  it("reject_final → Force Close → reopen → Force Close: Rev 1 'cannot confirm' with the index (it read green before this fix) and without it (base)", () => {
    let r = step(issuedAfterPaste(), "submit_final", "Submit Final");
    r = step(r, "reject_final", "Reject Final (Re-Open)");
    expect(r.history.at(-1)).toMatchObject({ revisionRound: 1 }); // the round reject_final opens for issue 1
    r = step(r, "close_ticket", "Force Close (Admin)");
    expect(ticketVerdict(withIndex(r), "1").verdict).toBe("unknown"); // the issued-label rule (DEC-44 (DF-P12) item 2)
    r = step(r, "reopen_ticket", "Reopen Ticket");
    r = step(r, "close_ticket", "Force Close (Admin)");
    expect([r.status, r.deliverable_rev, r.revision_count]).toEqual(["CLOSED", null, 2]);
    expect(provenIssueFromHistory(r.history, 0, r.revision_count, r.deliverable_rev)).toBe("1");
    expect(ticketVerdict(withIndex(r), "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: "1" });
    expect(ticketVerdict(withIndex(r, null), "1").verdict).toBe("unknown");
    expect(ticketVerdict(withIndex(r), "1A").verdict).toBe("draft_copy");
  });
  it("the same walk after a Rev 2: the sent-back Rev 2 'cannot confirm', the older Rev 1 stays superseded (red)", () => {
    let r = step(issuedAfterPaste(), "submit_final", "Submit Final");
    r = step(r, "close_ticket", "Close");
    r = step(r, "reopen_ticket", "Reopen Ticket"); // rc 1
    r = step(r, "submit_draft", "Submit for Review"); // 2A
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)"); // Rev 2 at rc 1
    expect(r.deliverable_rev).toBe("2");
    r = step(step(r, "submit_final", "Submit Final"), "reject_final", "Reject Final (Re-Open)"); // rc 2
    r = step(step(step(r, "close_ticket", "Force Close (Admin)"), "reopen_ticket", "Reopen Ticket"), "close_ticket", "Force Close (Admin)"); // rc 3
    expect(ticketVerdict(withIndex(r), "2").verdict).toBe("unknown");
    expect(ticketVerdict(withIndex(r), "1").verdict).toBe("superseded");
  });
  it("reject_final → 2A submitted → Force Close on 2A: Rev 1 'cannot confirm' when its issue is proven; without the index the ladder stays green (base — recorded, DEC-29)", () => {
    let r = step(issuedAfterPaste(), "submit_final", "Submit Final");
    r = step(r, "reject_final", "Reject Final (Re-Open)");
    r = step(r, "submit_draft", "Submit for Review");
    expect(r.deliverable_rev).toBe("2A");
    r = step(r, "close_ticket", "Force Close (Admin)");
    expect(provenSentBackAfterIssue(r.history, 0, "1")).toBe(true);
    expect(ticketVerdict(withIndex(r), "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: "1" });
    expect(ticketVerdict(withIndex(r), "2A").verdict).toBe("draft_copy");
    expect(ticketVerdict(withIndex(r, null), "1").verdict).toBe("current");
    // live (not closed) it was never green: the drawing is being re-worked
    const live = step(step(step(issuedAfterPaste(), "submit_final", "Submit Final"), "reject_final", "Reject Final (Re-Open)"), "submit_draft", "Submit for Review");
    expect(ticketVerdict(withIndex(live), "1").verdict).toBe("revision_in_progress");
  });
  it("REGRESSION — a normal close, a reopen with no new issue, and a reopen whose new draft is force-closed keep Rev 1 green", () => {
    const closed = step(step(issuedAfterPaste(), "submit_final", "Submit Final"), "close_ticket", "Close");
    expect(ticketVerdict(withIndex(closed), "1").verdict).toBe("current");
    const reclosed = step(step(closed, "reopen_ticket", "Reopen Ticket"), "close_ticket", "Force Close (Admin)");
    expect([reclosed.deliverable_rev, reclosed.revision_count]).toEqual([null, 1]); // the reopen is the one bump since the issue
    expect(ticketVerdict(withIndex(reclosed), "1")).toMatchObject({ verdict: "current", latestIssuedRev: "1" });
    // reopened, a new draft submitted and rejected (its round is 2, not the issue's 1), resubmitted, force-closed
    let r = step(closed, "reopen_ticket", "Reopen Ticket");
    r = step(r, "submit_draft", "Submit for Review"); // 2A
    r = step(r, "reject", "Reject");
    expect(r.history.at(-1)).toMatchObject({ revisionRound: 2 });
    r = step(step(r, "submit_draft", "Submit for Review"), "close_ticket", "Force Close (Admin)"); // 3A
    expect(r.deliverable_rev).toBe("3A");
    expect(provenSentBackAfterIssue(r.history, 0, "1")).toBe(false);
    expect(ticketVerdict(withIndex(r), "1").verdict).toBe("current");
    // reopened twice with no issue between: revision_count moved past the reopen — "cannot confirm", as base answered
    const twice = step(step(reclosed, "reopen_ticket", "Reopen Ticket"), "close_ticket", "Force Close (Admin)");
    expect(ticketVerdict(withIndex(twice), "1").verdict).toBe("unknown");
    // a CLOSED no-label row whose revision_count is unknown (an older caller) stays "cannot confirm"
    expect(ticketVerdict({ ...withIndex(reclosed), revision_count: undefined as unknown as number }, "1").verdict).toBe("unknown");
  });
  it("provenSentBackAfterIssue reads only rounds AFTER the proven issue's line, at or after the index; round N only", () => {
    const sent = { action: "Reject Final (Re-Open)", user: "r@x", revisionRound: 1 };
    expect(provenSentBackAfterIssue([issued(1), sent], 0, "1")).toBe(true);
    expect(provenSentBackAfterIssue([sent, issued(1)], 0, "1")).toBe(false); // before the issue: a round of an earlier cycle
    expect(provenSentBackAfterIssue([issued(1), sent], 1, "1")).toBe(false); // the issue line predates the index: not proven
    expect(provenSentBackAfterIssue([issued(1), { ...sent, revisionRound: 2 }], 0, "1")).toBe(false);
    expect(provenSentBackAfterIssue([issued(1), { ...sent, revisionRound: "1" }], 0, "1")).toBe(false);
    for (const g of [undefined, null, -1, 0.5]) expect(provenSentBackAfterIssue([issued(1), sent], g as number, "1")).toBe(false);
    expect(provenSentBackAfterIssue([issued(1), sent], 0, "1A")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHYS-17 — the record names the file; the stale-copies ticket arm
// ═════════════════════════════════════════════════════════════════════════════
describe("PHYS-17 — recordTicketCopy names the ticket and the file, and degrades before 20261223 / 20261068", () => {
  const file = { id: "a-1", name: "IFC.pdf", type: "Final" as const, rev: "1" };
  const base = { orgId: "org-1", userId: "u-1", userEmail: "u@x.io", userRole: "Engineer", ticketRowId: T, ticketNumber: "KE-1", file, channel: "print" as const, stamped: true, watermark: "UNCONTROLLED COPY", expiresAt: new Date("2026-11-12T00:00:00Z") };
  const mk = (results: Array<{ error: { code?: string; message?: string } | null }>) => {
    const rows: Array<Record<string, unknown>> = [];
    return { rows, client: { from: () => ({ insert: async (row: Record<string, unknown>) => { rows.push({ ...row }); return results.shift() ?? { error: null }; } }) } };
  };
  const ok = async () => ({ ok: true, error: null });
  it("after 20261223: one row with ticket_id and attachment_id", async () => {
    const { rows, client } = mk([{ error: null }]);
    expect(await recordTicketCopy(client, ok, base)).toEqual({ recorded: true, error: null });
    expect(rows).toEqual([expect.objectContaining({ ticket_id: T, attachment_id: "a-1", source: "drafting_print", user_id: "u-1" })]);
  });
  it("before 20261223 (PGRST204 / 42703 naming either column): retried once without them — today's row; the audit row still names the file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const err of [{ code: "PGRST204", message: "Could not find the 'attachment_id' column of 'download_audits' in the schema cache" }, { code: "42703", message: 'column "ticket_id" of relation "download_audits" does not exist' }]) {
      const { rows, client } = mk([{ error: err }, { error: null }]);
      const audit = vi.fn(ok);
      expect((await recordTicketCopy(client, audit, base)).recorded).toBe(true);
      expect(rows).toHaveLength(2);
      expect(Object.keys(rows[1]).sort()).toEqual(["expires_at", "org_id", "source", "user_email", "user_id"]);
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ attachmentId: "a-1", rev: "1" }) }));
    }
    expect(isMissingTicketCopyColumn({ code: "42501", message: "row-level security policy" })).toBe(false);
  });
  it("before 20261068 too: the third shape drops the channel and the ticket columns", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rows, client } = mk([{ error: { code: "PGRST204", message: "Could not find the 'source' column of 'download_audits' in the schema cache" } }, { error: null }]);
    expect((await recordTicketCopy(client, ok, base)).recorded).toBe(true);
    expect(Object.keys(rows[1]).sort()).toEqual(["expires_at", "org_id", "user_email", "user_id"]);
  });
});

describe("PHYS-17 / PHYS-8 dw3 — lib/staleCopies.ts gains a ticket arm keyed on (ticket_id, attachment_id) against the ticket's newer issue", () => {
  beforeEach(() => { st.recall = { data: null, error: null }; st.recallFilters = []; st.emits = []; st.audits = []; });
  const ticket = {
    id: T, orgId: ORG, status: "PENDING_IFC", deliverableRev: "2", revisionCount: 1, history: [issued(1), issued(2)],
    attachments: [{ id: "f-1", type: "Final", rev: "1" }, { id: "f-2", type: "Final", rev: "2" }, { id: "d-1", type: "Draft", rev: "2A" }],
  };
  it("holders of a superseded file are outdated; a holder who re-took the current file is not; read in the ticket's org, by ticket, in the window", async () => {
    const { getTicketCopyRecall } = await import("@/lib/staleCopies");
    st.recall = { data: [
      { user_id: "u-a", user_email: "a@x", attachment_id: "f-1", created_at: "2026-10-01T00:00:00Z", source: "drafting_print" },
      { user_id: "u-b", user_email: "b@x", attachment_id: "f-2", created_at: "2026-10-03T00:00:00Z", source: "drafting" },
      { user_id: "u-b", user_email: "b@x", attachment_id: "f-1", created_at: "2026-10-02T00:00:00Z", source: "drafting" },
      { user_id: "u-c", user_email: "c@x", attachment_id: "d-1", created_at: "2026-10-04T00:00:00Z", source: "drafting" },
    ], error: null };
    const r = await getTicketCopyRecall(ticket);
    expect(r.unavailable).toBe(false);
    expect(r.latestIssuedRev).toBe("2");
    const by = Object.fromEntries(r.holders.map((h) => [h.userId, h]));
    expect(by["u-a"]).toMatchObject({ outdated: true, hasCurrent: false });
    expect(by["u-a"].copies[0]).toMatchObject({ attachmentId: "f-1", rev: "1", verdict: "superseded" });
    expect(by["u-b"]).toMatchObject({ outdated: true, hasCurrent: true });
    expect(by["u-c"]).toMatchObject({ outdated: true, hasCurrent: false }); // a review draft of an issued cycle
    expect(r.holders[0].userId).not.toBe("u-b");
    expect(st.recallFilters).toEqual(expect.arrayContaining([["org_id", ORG], ["ticket_id", T]]));
  });
  it("a copy of the draft UNDER REVIEW now is the reviewers' working copy — neither outdated nor nudged; a review draft is outdated once the ticket has moved past it", async () => {
    const { getTicketCopyRecall, nudgeStaleTicketHolders } = await import("@/lib/staleCopies");
    const inReview = {
      id: T, orgId: ORG, status: "PENDING_REVIEW", deliverableRev: "2B", revisionCount: 1, history: [issued(1)],
      attachments: [{ id: "f-1", type: "Final", rev: "1" }, { id: "d-a", type: "Draft", rev: "2A" }, { id: "d-b", type: "Draft", rev: "2B" }],
    };
    st.recall = { data: [
      { user_id: "u-rev", user_email: "rev@x", attachment_id: "d-b", created_at: "2026-10-05T00:00:00Z", source: "drafting_print" },
      { user_id: "u-old", user_email: "old@x", attachment_id: "d-a", created_at: "2026-10-04T00:00:00Z", source: "drafting_print" },
    ], error: null };
    const r = await getTicketCopyRecall(inReview);
    const by = Object.fromEntries(r.holders.map((h) => [h.userId, h]));
    expect(by["u-rev"]).toMatchObject({ outdated: false, hasCurrent: false });
    expect(by["u-rev"].copies[0]).toMatchObject({ rev: "2B", verdict: "draft_copy", underReview: true });
    expect(by["u-old"]).toMatchObject({ outdated: true }); // 2A: the label has moved on to 2B
    expect(by["u-old"].copies[0]).toMatchObject({ rev: "2A", underReview: false });
    expect(await nudgeStaleTicketHolders({ orgId: ORG, ticketId: T, ticketNumber: "KE-1", latestIssuedRev: r.latestIssuedRev, holders: r.holders, actorUserId: "u-boss" })).toBe(1);
    expect(st.emits[0]).toMatchObject({ audience: { involved: ["u-old"] } });
    // once the review ends (approved → an issued label, or the request closed on that label), the 2B copy is outdated too
    st.emits = []; st.audits = [];
    for (const after of [{ status: "PENDING_IFC", deliverableRev: "2", revisionCount: 1, history: [issued(1), issued(2)] }, { status: "CLOSED", deliverableRev: "2B" }]) {
      const r2 = await getTicketCopyRecall({ ...inReview, ...after });
      expect(r2.holders.find((h) => h.userId === "u-rev"), JSON.stringify(after)).toMatchObject({ outdated: true });
    }
  });
  it("an unreadable record (before 20261223, or any failure) is a GAP — never 'nobody holds a copy'", async () => {
    const { getTicketCopyRecall } = await import("@/lib/staleCopies");
    st.recall = { data: null, error: { code: "42703", message: "column download_audits.ticket_id does not exist" } };
    expect(await getTicketCopyRecall(ticket)).toMatchObject({ holders: [], unavailable: true });
  });
  it("the recall nudge tells outdated holders who have not re-taken the current file, and records who, on the ticket's trail", async () => {
    const { getTicketCopyRecall, nudgeStaleTicketHolders } = await import("@/lib/staleCopies");
    st.recall = { data: [
      { user_id: "u-a", user_email: "a@x", attachment_id: "f-1", created_at: "2026-10-01T00:00:00Z", source: "drafting_print" },
      { user_id: "u-b", user_email: "b@x", attachment_id: "f-2", created_at: "2026-10-03T00:00:00Z", source: "drafting" },
      { user_id: "u-b", user_email: "b@x", attachment_id: "f-1", created_at: "2026-10-02T00:00:00Z", source: "drafting" },
    ], error: null };
    const r = await getTicketCopyRecall(ticket);
    const n = await nudgeStaleTicketHolders({ orgId: ORG, ticketId: T, ticketNumber: "KE-1", latestIssuedRev: r.latestIssuedRev, holders: r.holders, actorUserId: "u-boss", actorName: "boss@x" });
    expect(n).toBe(1);
    expect(st.emits).toHaveLength(1);
    expect(st.emits[0]).toMatchObject({ kind: "doc_recalled", category: "recall", resource: { type: "ticket", id: T }, audience: { involved: ["u-a"] }, link: `/requests/${T}` });
    expect(st.audits).toEqual([expect.objectContaining({ action: "DISTRIBUTION_RECALL", resourceType: "ticket", resourceId: T, details: expect.objectContaining({ recipientCount: 1 }) })]);
    // an unavailable record nudges nobody and says so on the trail
    st.emits = []; st.audits = [];
    expect(await nudgeStaleTicketHolders({ orgId: ORG, ticketId: T, ticketNumber: "KE-1", latestIssuedRev: "2", holders: [], actorUserId: "u-boss", unavailable: true })).toBe(0);
    expect(st.emits).toEqual([]);
    expect(st.audits[0]).toMatchObject({ details: expect.objectContaining({ unavailable: true, recipientCount: 0 }) });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// /api/verify-ticket — ?a=, printed_ref, the trust index with its fallback
// ═════════════════════════════════════════════════════════════════════════════
describe("/api/verify-ticket — the file's identity and 20261221's index at the door", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    st.ticket = null; st.ticketSelects = []; st.ticketSelectErrors = []; st.inserts = []; st.insertErrors = {};
  });
  async function call(params: Record<string, string>) {
    const { GET } = await import("@/app/api/verify-ticket/route");
    const u = new URL("https://app/api/verify-ticket");
    u.searchParams.set("t", T);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await GET(new NextRequest(u));
    return { res, body: (await res.json()) as Record<string, unknown> };
  }
  const row = (over: Record<string, unknown>) => ({ id: T, ticket_id: "KE-9", title: "Tie-in", status: "PENDING_IFC", deliverable_rev: "1", revision_count: 0, history: [issued(1)], archived_at: null, ...over });
  const scans = () => st.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row);

  it("a QR naming the file: attachments are read, the identity decides, and the scan row records the printing (printed_ref)", async () => {
    const FID = "6f1c2a9e-0d3b-4c8e-9a7f-1b2c3d4e5f60";
    st.ticket = row({ attachments: [{ id: FID, type: "Final", rev: "1" }] });
    const ok = await call({ r: "1", a: FID });
    expect(ok.body.verdict).toBe("current");
    expect(st.ticketSelects.at(-1)).toBe("id, ticket_id, title, status, deliverable_rev, history, revision_count, archived_at, attachments, history_guarded_from");
    expect(scans().at(-1)).toMatchObject({ printed_ref: FID, verdict: "current" });
    const bad = await call({ r: "1", a: "not-on-this-ticket" });
    expect(bad.body.verdict).toBe("unknown");
    expect(Object.keys(ok.body)).not.toContain("attachments");
    expect(Object.keys(ok.body)).not.toContain("history_guarded_from");
  });
  it("a malformed file id is an invalid code (400), logged as such", async () => {
    st.ticket = row({});
    const { res } = await call({ r: "1", a: "../../etc" });
    expect(res.status).toBe(400);
    expect(scans().at(-1)).toMatchObject({ verdict: "invalid" });
  });
  it("before 20261221 (the column is unknown): read again without it — today's verdict; any other read failure stays an outage (503)", async () => {
    st.ticket = row({ status: "CLOSED", deliverable_rev: null, revision_count: 2, history: [issued(1), issued(2)], history_guarded_from: 0 });
    st.ticketSelectErrors = [{ code: "42703", message: "column tickets.history_guarded_from does not exist" }];
    const pre = await call({ r: "2" });
    expect(pre.res.status).toBe(200);
    expect(st.ticketSelects).toEqual([
      "id, ticket_id, title, status, deliverable_rev, history, revision_count, archived_at, history_guarded_from",
      "id, ticket_id, title, status, deliverable_rev, history, revision_count, archived_at",
    ]);
    st.ticketSelectErrors = [{ code: "08006", message: "connection failure" }];
    vi.resetModules();
    const down = await call({ r: "2" });
    expect(down.res.status).toBe(503);
  });
  it("after 20261221: a ticket reopened and force-closed after a PROVEN issue scans its last issue current (it answered 'cannot confirm' before)", async () => {
    st.ticket = row({ status: "CLOSED", deliverable_rev: null, revision_count: 2, history: [issued(1), issued(2), { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }], history_guarded_from: 1 });
    expect((await call({ r: "2" })).body).toMatchObject({ verdict: "current", latestIssuedRev: "2" });
    st.ticket = { ...st.ticket, history_guarded_from: null };
    expect((await call({ r: "2" })).body.verdict).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EVID-16 — POST /api/tickets/copy
// ═════════════════════════════════════════════════════════════════════════════
const KEY = `orgs/${ORG}/tickets/KE-9/ifc-rev1.pdf`;
async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return new Uint8Array(await d.save());
}
describe("EVID-16 — the ticket copy is stamped and recorded in the server request that issues its bytes", () => {
  const ticketRow = (over: Record<string, unknown> = {}) => ({
    id: T, org_id: ORG, ticket_id: "KE-9", status: "PENDING_IFC", deliverable_rev: "1", revision_count: 0, history: [issued(1)],
    attachments: [{ id: "f-1", name: "ifc-rev1.pdf", url: KEY, type: "Final", status: "submitted", rev: "1" }],
    archived_at: null, requester_id: "u-req", assigned_drafter_id: "u-drafter", assigned_engineer_id: null, watchers: [], ...over,
  });
  beforeEach(async () => {
    vi.resetModules();
    st.user = { id: "u-drafter", email: "drafter@plant.test" };
    st.member = { uid: "u-drafter", role: "Drafter", roles: ["Drafter"], email: "drafter@plant.test" };
    st.ticket = ticketRow();
    st.ticketSelects = []; st.ticketSelectErrors = []; st.inserts = []; st.insertErrors = {}; st.mentions = []; st.r2Error = null;
    st.objects = { [KEY]: await pdfBytes() };
    process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  });
  async function post(body: Record<string, unknown>, token: string | null = "good") {
    const { POST } = await import("@/app/api/tickets/copy/route");
    return POST(new NextRequest("https://app.example.com/api/tickets/copy", {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    }));
  }
  const ins = (t: string) => st.inserts.filter((i) => i.table === t).map((i) => i.row);

  it("issues the STAMPED bytes and, in the same request and BEFORE them, the distribution row (naming the ticket and the file) and the audit row", async () => {
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "print" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-ticket-copy-stamped")).toBe("1");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(st.objects[KEY].length); // the marks were drawn
    expect(ins("download_audits")).toEqual([expect.objectContaining({ org_id: ORG, user_id: "u-drafter", source: "drafting_print", ticket_id: T, attachment_id: "f-1" })]);
    expect(ins("audit_logs")).toEqual([expect.objectContaining({ action: "DOWNLOAD", resource_type: "ticket", resource_id: T, org_id: ORG, user_id: "u-drafter",
      details: expect.objectContaining({ attachmentId: "f-1", rev: "1", channel: "print", watermark: "UNCONTROLLED COPY" }) })]);
  });
  it("a refused record issues NOTHING (503 unrecorded) — a copy does not leave unrecorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    st.insertErrors = { download_audits: [{ code: "42501", message: "new row violates row-level security policy" }] };
    const res = await post({ ticketId: T, attachmentId: "f-1", channel: "download" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("unrecorded");
    st.insertErrors = { audit_logs: [{ message: "audit refused" }] };
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "download" })).status).toBe(503);
  });
  it("a superseded file is confirmed first (409 confirm), then issued stamped SUPERSEDED on the acknowledged retry", async () => {
    st.ticket = ticketRow({ deliverable_rev: "2", revision_count: 1, history: [issued(1), issued(2)] });
    const first = await post({ ticketId: T, attachmentId: "f-1", channel: "print" });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "confirm", standing: { kind: "superseded", by: "2" } });
    expect(ins("download_audits")).toEqual([]);
    const second = await post({ ticketId: T, attachmentId: "f-1", channel: "print", acknowledged: true });
    expect(second.status).toBe(200);
    expect(ins("download_audits")).toHaveLength(1);
  });
  it("a file that cannot be stamped asks first (422), and goes out recorded as unstamped only on the retry that accepts it", async () => {
    st.objects[KEY] = new TextEncoder().encode("not a pdf at all");
    const first = await post({ ticketId: T, attachmentId: "f-1", channel: "download" });
    expect(first.status).toBe(422);
    expect(ins("download_audits")).toEqual([]);
    const second = await post({ ticketId: T, attachmentId: "f-1", channel: "download", acceptUnstamped: true });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ticket-copy-stamped")).toBe("0");
    expect(ins("download_audits")[0]).toMatchObject({ source: "drafting_unstamped" });
    expect(ins("audit_logs")[0]).toMatchObject({ details: expect.objectContaining({ watermark: "UNSTAMPED (stamping failed)" }) });
  });
  it("doors: no session 401; bad body 400; not a member / outside a Contractor's scope 404; archived 409; not this ticket's file 404; a legacy URL or a key outside the ticket's prefix 409", async () => {
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" }, null)).status).toBe(401);
    expect((await post({ ticketId: "x", attachmentId: "f-1", channel: "print" })).status).toBe(400);
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "fax" })).status).toBe(400);
    st.member = null;
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" })).status).toBe(404);
    st.member = { uid: "u-drafter", role: "Contractor", roles: ["Contractor"] };
    st.ticket = ticketRow({ assigned_drafter_id: "someone-else" });
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" })).status).toBe(404);
    st.member = { uid: "u-drafter", role: "Drafter", roles: ["Drafter"] };
    st.ticket = ticketRow({ archived_at: "2026-09-01T00:00:00Z" });
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" })).status).toBe(409);
    st.ticket = ticketRow();
    expect((await post({ ticketId: T, attachmentId: "f-9", channel: "print" })).status).toBe(404);
    st.ticket = ticketRow({ attachments: [{ id: "f-1", name: "x.pdf", url: "https://cdn.example.com/x.pdf", type: "Final", rev: "1" }] });
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" })).status).toBe(409);
    st.ticket = ticketRow({ attachments: [{ id: "f-1", name: "x.pdf", url: `orgs/${ORG}/libraries/l/x.pdf`, type: "Final", rev: "1" }] });
    expect((await post({ ticketId: T, attachmentId: "f-1", channel: "print" })).status).toBe(409);
    expect(ins("download_audits")).toEqual([]);
  });
  it("a creation-time file left at the REQUESTER's staged key (its re-key never ran) is issued like any other; another member's staged key, or another workspace's, is not", async () => {
    const REQ = "22222222-2222-2222-2222-222222222222";
    const STAGED = `orgs/${ORG}/tickets/pending/${REQ}/33333333-3333-3333-3333-333333333333/1760000000000_source.pdf`;
    st.objects[STAGED] = await pdfBytes();
    st.ticket = ticketRow({ requester_id: REQ, attachments: [{ id: "s-1", name: "source.pdf", url: STAGED, type: "Source", status: "submitted", rev: null }] });
    const ok = await post({ ticketId: T, attachmentId: "s-1", channel: "download" });
    expect(ok.status).toBe(200);
    expect(ins("download_audits")).toEqual([expect.objectContaining({ ticket_id: T, attachment_id: "s-1" })]);
    // staged by somebody else (the row names a key under another member's staging folder)
    st.ticket = ticketRow({ requester_id: "44444444-4444-4444-4444-444444444444", attachments: [{ id: "s-1", name: "source.pdf", url: STAGED, type: "Source", rev: null }] });
    expect((await post({ ticketId: T, attachmentId: "s-1", channel: "download" })).status).toBe(409);
    // another workspace's staging folder
    const FOREIGN = `orgs/55555555-5555-5555-5555-555555555555/tickets/pending/${REQ}/33333333-3333-3333-3333-333333333333/1760000000000_source.pdf`;
    st.ticket = ticketRow({ requester_id: REQ, attachments: [{ id: "s-1", name: "source.pdf", url: FOREIGN, type: "Source", rev: null }] });
    expect((await post({ ticketId: T, attachmentId: "s-1", channel: "download" })).status).toBe(409);
    expect(ins("download_audits")).toHaveLength(1);
  });
  it("the plan is the page's (lib/ticketDeliverableCopy.ts) — read with the ticket as it stands, and 20261221's index when the column exists", () => {
    const s = src("app/api/tickets/copy/route.ts");
    expect(s).toContain("ticketCopyPlan({");
    expect(s).toContain("historyGuardedFrom: t.history_guarded_from ?? null");
    expect(s).toContain("recordTicketCopy(supabaseAdmin, serverAudit,");
    // the record precedes the response that carries the bytes
    expect(s.indexOf("recordTicketCopy(supabaseAdmin")).toBeLessThan(s.indexOf("new NextResponse(Buffer.from(out)"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The landing page — forwards ?a=; NOT ISSUED vs WITHDRAWN (decided under DEC-90)
// ═════════════════════════════════════════════════════════════════════════════
describe("the /verify-ticket page — forwards the file's id; a request that never issued says NOT ISSUED, red either way", () => {
  const p = src("app/verify-ticket/[ticketId]/page.tsx");
  it("forwards ?a= to the API exactly as printed", () => {
    expect(p).toContain('const attachment = search.get("a");');
    expect(p).toContain('if (attachment) qs.set("a", attachment);');
    expect(p).toContain("}, [params.ticketId, rev, attachment]);");
  });
  it("withdrawn stays red; its headline and sentence say which — NOT ISSUED with no issue on record, WITHDRAWN after one", () => {
    expect(p).toMatch(/withdrawn: \{\s*bg: "bg-red-600", icon: "stop", headline: "WITHDRAWN — DO NOT USE"/);
    expect(p).toContain('return result.verdict === "withdrawn" && !result.latestIssuedRev ? "NOT ISSUED — DO NOT USE" : ui.headline;');
    expect(p).toContain("{headlineFor(result, ui)}</h1>");
    expect(p).toContain("This request was withdrawn after Rev ${r.latestIssuedRev} was issued.");
    expect(p).toContain("for example a question answered without a drawing");
  });
});
