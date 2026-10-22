// drafting-flow Round G, DF-P7 CONSENT — the shape of 20261255 (DEC-30 one
// paste; DRLS-16; DEC-38's one transaction). Exercised at runtime on a
// throwaway PostgreSQL 16 in lib/__tests__/rls/dfP7ConsentWindow.test.ts.
//
// ticket_update_guard is NOT re-created here (the columns get their own
// trigger), so its newest body stays 20261250's — a folder scan pins that.
// The two ticket_review_slots CHECKs are re-created from 20261242's text with
// exactly the consent alternative added (pinned against that file).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONSENT_WINDOW_COLUMNS } from "@/lib/consentWindow";
import { KIND_META } from "@/lib/notificationKinds";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const F = "20261255_df_roundG_consent_window.sql";
const M = mig(F);
const S = strip(M);
function fnBody(name: string): string {
  const a = S.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(a, name).toBeGreaterThanOrEqual(0);
  const b = S.indexOf("\n$$;", a);
  return S.slice(a, b + 4);
}

describe("DEC-30 one-paste shape", () => {
  it("the reserved number, and nothing else in the folder takes it", () => {
    expect(files.filter((f) => f.startsWith("20261255"))).toEqual([F]);
  });
  it("prerequisite check → TEMP counts-only inventory → one BEGIN / COMMIT → ONE final SELECT (check, ok, n)", () => {
    const begin = S.indexOf("\nBEGIN;\n");
    expect(S.match(/\nBEGIN;\n/g)).toHaveLength(1);
    expect(S.match(/\nCOMMIT;\n/g)).toHaveLength(1);
    expect(S.indexOf("RAISE EXCEPTION '20261255 needs 20261241")).toBeLessThan(S.indexOf("CREATE TEMP TABLE df_round_g_255_before"));
    expect(S.indexOf("CREATE TEMP TABLE df_round_g_255_before")).toBeLessThan(begin);
    const inv = S.slice(S.indexOf("CREATE TEMP TABLE"), begin);
    // counts only: every branch selects a COUNT(*) as the value, never a row's content
    for (const branch of inv.split(/UNION ALL/)) expect(branch, branch.slice(0, 80)).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT\s+t\.(title|description|metadata)\b/);
    const tail = S.slice(S.indexOf("\nCOMMIT;\n") + 9);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,/);
    expect(tail).toMatch(/AS ok,/);
    expect(tail).toMatch(/NULL::text AS n/);
    // Fix pass 2: the rows are ordered by the OUTER query (sec, ord), never
    // by an ORDER BY inside a UNION ALL branch (PostgreSQL keeps no such order).
    expect(tail).toMatch(/^\s*(--[^\n]*\n)*SELECT "check", ok, n FROM \(/);
    expect(tail).toMatch(/SELECT 2, ord, inventory, NULL, n FROM df_round_g_255_before\n/);
    expect(tail).toMatch(/\) AS final_rows\nORDER BY sec, ord;\s*$/);
    expect(tail.slice(0, tail.lastIndexOf(") AS final_rows"))).not.toMatch(/ORDER BY/);
    // every probe has its own place: 1..10 in section 1
    expect([...tail.matchAll(/SELECT 1(?: AS sec)?, (\d+)(?: AS ord)?, '/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("DEC-35: no facility vocabulary", () => {
    expect(S).not.toMatch(/\bQAQC\b|QA\/QC|\bB31|\bNDE\b|radiograph|PENDING_DOC_CTRL/);
  });
});

describe("the columns, their guard, and ticket_update_guard left as it is", () => {
  it("adds exactly the ten columns the app reads (lib/consentWindow.ts CONSENT_WINDOW_COLUMNS), all-or-none when open", () => {
    const added = [...S.matchAll(/ALTER TABLE tickets ADD COLUMN IF NOT EXISTS (\w+)/g)].map((x) => x[1]);
    expect(added).toEqual([...CONSENT_WINDOW_COLUMNS]);
    expect(S).toContain("ADD CONSTRAINT tickets_consent_window_shape CHECK (");
    expect(S).toContain("cardinality(consent_window_recipients) > 0");
  });
  it("a client neither writes nor inserts one: its own trigger, SECURITY INVOKER, search_path pinned, EXECUTE revoked; the service role passes", () => {
    const g = fnBody("ticket_consent_window_guard");
    expect(g).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(g).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    for (const c of CONSENT_WINDOW_COLUMNS) expect(g, c).toContain(`array_append(v_bad, '${c}')`);
    expect(S).toContain("CREATE TRIGGER trg_ticket_consent_window_guard\n  BEFORE INSERT OR UPDATE ON tickets");
    expect(S).toContain("REVOKE ALL ON FUNCTION ticket_consent_window_guard() FROM PUBLIC, anon, authenticated, service_role;");
  });
  it("FOLDER SCAN: ticket_update_guard is not re-created here; its newest body is still 20261250's", () => {
    expect(S).not.toContain("FUNCTION ticket_update_guard()");
    const definers = files.filter((f) => strip(mig(f)).includes("CREATE OR REPLACE FUNCTION ticket_update_guard()"));
    expect(definers.at(-1)).toBe("20261250_df_roundG_review_model.sql");
  });
});

describe("DEC-38 / DRLS-16 — open_consent_window and record_consent_window_warning", () => {
  for (const [name, sig] of [
    ["open_consent_window", "UUID, UUID, TEXT, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, JSONB"],
    ["record_consent_window_warning", "UUID, UUID, UUID[], TEXT, TEXT, JSONB"],
  ] as const) {
    it(`${name}: SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only; refuses a session`, () => {
      const b = fnBody(name);
      expect(b).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
      expect(b).toContain("IF auth.uid() IS NOT NULL THEN");
      expect(S).toContain(`REVOKE ALL ON FUNCTION ${name}(${sig}) FROM PUBLIC, anon, authenticated;`);
      expect(S).toContain(`GRANT EXECUTE ON FUNCTION ${name}(${sig}) TO service_role;`);
      expect(S.match(new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(`, "g"))).toHaveLength(1);
    });
  }
  it("ONE transaction, in this order: refuse an empty set → lock the ticket → the slot's own occupants, active → the notifications → their delivered events → the count check → only then the stamp", () => {
    const b = fnBody("open_consent_window");
    const at = (s: string) => { const i = b.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      "nobody to ask — no window is opened",
      "FOR UPDATE",
      "only the slot''s own occupants are asked",
      "no longer an active member",
      "INSERT INTO notifications",
      "INSERT INTO ticket_notice_events",
      "GET DIAGNOSTICS v_n = ROW_COUNT;",
      "IF v_n <> v_asked THEN",
      "UPDATE tickets SET",
    ].map(at);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // no exception handler swallows a failure: any refusal rolls the whole call back
    expect(b).not.toMatch(/EXCEPTION\s+WHEN/);
    expect(b).toContain("consent_window_opened_at = v_now,");
    expect(b).toContain("jsonb_set(metadata, '{review_roster,consentWindow}'");
  });
  it("DF-P7 fix pass (review major): the slot, its mode, its status and its occupants are read from the service-written LEDGER, not metadata alone", () => {
    const b = fnBody("open_consent_window");
    expect(b).toContain("v_ls ticket_review_slots%ROWTYPE;");
    expect(b).toContain("SELECT * INTO v_ls FROM ticket_review_slots\n   WHERE ticket_id = p_ticket AND org_id = v_t.org_id AND roster_id = p_roster AND slot_kind = p_slot;");
    expect(b).toContain("IF NOT FOUND OR v_ls.mode <> 'consent_window' OR v_ls.status <> 'open' OR v_ls.fallback THEN");
    expect(b).toContain("IF NOT (p_recipients <@ v_ls.primaries) THEN");
    // the metadata primaries are no longer the authority for who may be asked
    expect(b).not.toContain("v_slot->'primaries'");
    // the ledger check comes before any row is written
    expect(b.indexOf("FROM ticket_review_slots")).toBeLessThan(b.indexOf("INSERT INTO notifications"));
  });
  it("DEC-12 / DEC-37 (review blocker): the drafter is never asked; nor the requester on a slot independent of the requester", () => {
    const b = fnBody("open_consent_window");
    expect(b).toContain("IF v_t.assigned_drafter_id IS NOT NULL AND v_t.assigned_drafter_id = ANY (p_recipients) THEN");
    expect(b).toContain("IF 'requester' = ANY (v_ls.independent_of) AND v_t.requester_id = ANY (p_recipients) THEN");
    expect(b.indexOf("assigned_drafter_id = ANY (p_recipients)")).toBeLessThan(b.indexOf("INSERT INTO notifications"));
  });
  it("DEC-37 slot-to-slot (fix pass 2): nobody who signed, or can still sign, a slot this one must be independent of (either direction) is asked — read from the ledger, before any row", () => {
    const b = fnBody("open_consent_window");
    expect(b).toContain("AND (o.slot_kind = ANY (v_ls.independent_of) OR p_slot = ANY (o.independent_of))");
    expect(b).toContain("AND ((o.status = 'satisfied' AND o.satisfied_by = ANY (p_recipients))");
    expect(b).toContain("OR (o.status = 'open' AND (o.primaries && p_recipients OR o.alternates && p_recipients OR o.overriders && p_recipients)))) THEN");
    expect(b).toContain("WHERE o.ticket_id = p_ticket AND o.roster_id = p_roster AND o.slot_kind <> p_slot");
    expect(b.indexOf("o.satisfied_by = ANY (p_recipients)")).toBeLessThan(b.indexOf("INSERT INTO notifications"));
  });
  it("the reminder reaches everyone asked and is recorded with its rows; no exception handler", () => {
    const b = fnBody("record_consent_window_warning");
    expect(b).toContain("IF NOT (v_t.consent_window_recipients <@ p_recipients) THEN");
    expect(b.indexOf("INSERT INTO notifications")).toBeLessThan(b.indexOf("consent_window_warned_at = v_now"));
    expect(b).not.toMatch(/EXCEPTION\s+WHEN/);
  });
  it("the notices are of an existing kind (ticket_status) — notification_kinds() is not re-created", () => {
    expect(KIND_META.ticket_status).toBeTruthy();
    expect(S.match(/'ticket_status'/g)!.length).toBeGreaterThanOrEqual(2);
    expect(S).not.toContain("FUNCTION notification_kinds()");
  });
});

describe("ticket_notice_events — append-only, read as the ticket reads", () => {
  it("the kinds are exactly the ones written: delivered / warned by the two functions, the rest by the app", () => {
    const kinds = [...S.match(/kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/)![1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    expect(kinds).toEqual(["delivered", "warned", "objected", "expired", "advanced", "blocked", "not_emailed"]);
    const app = ["lib/consentWindowScan.ts", "app/api/tickets/workflow-action/route.ts"].map((f) => readFileSync(join(process.cwd(), f), "utf8")).join("\n");
    for (const k of ["objected", "expired", "advanced", "blocked", "not_emailed"]) expect(app, k).toContain(`"${k}"`);
    expect(fnBody("open_consent_window")).toContain("'delivered'");
    expect(fnBody("record_consent_window_warning")).toContain("'warned'");
  });
  it("cascades with its ticket and org; UPDATE refused; DELETE only once the ticket or the org is gone; no client write; one SELECT policy", () => {
    expect(S).toContain("org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE");
    expect(S).toContain("ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE");
    const t = fnBody("ticket_notice_events_append_only");
    expect(t).toContain("IF TG_OP = 'UPDATE' THEN");
    expect(t).toContain("IF EXISTS (SELECT 1 FROM tickets WHERE id = OLD.ticket_id)\n     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN");
    expect(S).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_notice_events FROM anon, authenticated;");
    expect(S.match(/CREATE POLICY ticket_notice_events_\w+ ON ticket_notice_events/g)).toHaveLength(1);
    expect(S).toContain("USING ((kind <> 'not_emailed' OR recipient = auth.uid())");
  });
});

describe("the roster ledger's two CHECKs — 20261242's, with exactly the consent alternative", () => {
  const OLD = strip(mig("20261242_df_roundG_ticket_roster.sql"));
  it("FOLDER SCAN: 20261242 is still the newest definition of both CHECKs before 20261255 (a later re-definition would be reverted by this paste)", () => {
    const before = files.filter((f) => f < F);
    const defines = (sql: string) => /ADD CONSTRAINT ticket_review_slots_satisfied_(shape|via_check)\b/.test(sql)
      || /CONSTRAINT ticket_review_slots_satisfied_shape CHECK/.test(sql)
      || /satisfied_via TEXT CHECK/.test(sql);
    const definers = before.filter((f) => defines(strip(mig(f))));
    expect(definers.at(-1)).toBe("20261242_df_roundG_ticket_roster.sql");
    // and nothing after 20261255 in the folder re-defines them either —
    // except drafting-flow DF-P22's 20261264, which re-creates the
    // satisfied_via CHECK from THIS file's body plus one value
    // ('preauthorization'), pinned byte for byte by
    // dfRoundG_P22_preauthMigration.test.ts (the shape CHECK it never touches).
    // drafting-flow DF-P26's 20261268 re-creates BOTH — the satisfied_via CHECK
    // from 20261264's body and the shape CHECK from THIS file's body, each with
    // the exception-only rule's one alternative — pinned byte for byte by
    // dfRoundG_P26_exceptionMigration.test.ts.
    expect(files.filter((f) => f > F && defines(strip(mig(f))))).toEqual(["20261264_df_roundG_consent_escalation.sql", "20261268_df_roundG_issuing_path_stops.sql"]);
  });
  it("satisfied_via: 20261242's list plus 'consent'", () => {
    expect(OLD).toContain("satisfied_via TEXT CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override')),");
    expect(S).toContain("CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent'));");
  });
  it("the shape: every non-consent satisfied slot still names its signer and its signature (20261242's conjunct, kept); a consent slot names neither", () => {
    expect(OLD).toContain("(status = 'satisfied') = (satisfied_by IS NOT NULL AND satisfied_at IS NOT NULL AND signature_id IS NOT NULL)");
    expect(S).toContain("(satisfied_by IS NOT NULL AND signature_id IS NOT NULL AND satisfied_via IS DISTINCT FROM 'consent')");
    // Fix pass 2: the consent limb holds only on a consent_window slot — a
    // blocking slot can never be recorded satisfied with no signer.
    expect(S).toContain("OR (satisfied_via = 'consent' AND mode = 'consent_window' AND satisfied_by IS NULL AND signature_id IS NULL)");
    expect(S).toContain("(status = 'satisfied') = (satisfied_at IS NOT NULL AND (");
  });
});
