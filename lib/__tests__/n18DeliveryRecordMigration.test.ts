// notifications Round G — N18 DELIVERY RECORD: migration 20261258 (drafting-
// flow EVID-9 done-whens 1–4, EVID-13's remainder; DEC-90 — fail-safe, no
// regression).
//
//   * email_gate() re-created from its NEWEST earlier definition (found by
//     scanning the folder — 20261191 today) with exactly ONE added line: the
//     60-second repeat check ignores a not_emailed record. lineDiff + an exact
//     cut prove every other byte is the base's.
//   * the DEC-30 one-paste shape: the prerequisite check and the counts-only
//     inventory BEFORE the transaction, BEGIN / COMMIT once, ONE final SELECT
//     (check, ok, n).
//   * DRLS-16 for both SECURITY DEFINER functions (search_path pinned, EXECUTE
//     revoked from PUBLIC / anon, granted narrowly).
//   * the status CHECK keeps every earlier value and adds only not_emailed.
//
// The runtime proof — on the replayed PostgreSQL 16 — is
// lib/__tests__/rls/n18DeliveryRecord.test.ts (`npm run test:db`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261258_notif_roundG_delivery_record.sql";
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

const HEAD = "CREATE OR REPLACE FUNCTION email_gate(";
const defining = files.filter((f) => stripComments(mig(f)).includes(HEAD));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), HEAD, "\n$$;"), next: between(M, HEAD, "\n$$;") };
const ADDED = "       AND e.status <> 'not_emailed'";

describe("20261258 — email_gate() re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261191 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261191_notif_roundG_kind_split.sql").toBe(true);
  });

  it("lineDiff: no base line is lost; the one line added is the not_emailed filter in the repeat check", () => {
    const d = lineDiff(G.live, G.next);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([ADDED]);
  });

  it("exact cut: the body minus that one line IS the base, byte for byte, and the line sits inside the repeat check's WHERE", () => {
    expect(G.next.split(`${ADDED}\n`).length).toBe(2);
    expect(G.next.replace(`${ADDED}\n`, "")).toBe(G.live);
    expect(G.next).toMatch(/AND e\.org_id = p_org\n {7}AND e\.status <> 'not_emailed'\n {7}AND e\.created_at >= now\(\) - interval '60 seconds'/);
  });

  it("TRIPWIRE: every later re-create of email_gate keeps the not_emailed filter (start from the NEWEST body)", () => {
    for (const later of defining.filter((f) => f > FILE)) expect(between(mig(later), HEAD, "\n$$;"), later).toContain(ADDED);
  });

  it("restates EXECUTE as 20261191 does (authenticated and service_role; never PUBLIC or anon)", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;");
  });
});

describe("20261258 — the DEC-30 one-paste shape", () => {
  const code = stripComments(M);
  const begin = code.indexOf("\nBEGIN;");
  const commit = code.indexOf("\nCOMMIT;");

  it("one BEGIN and one COMMIT; the prerequisite check and the counts-only inventory come BEFORE the transaction", () => {
    expect(code.split("\nBEGIN;").length).toBe(2);
    expect(code.split("\nCOMMIT;").length).toBe(2);
    expect(code.indexOf("RAISE EXCEPTION '20261258 needs 20261148")).toBeLessThan(begin);
    const temp = code.indexOf("CREATE TEMP TABLE notif_round_g_258_before AS");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    const inventory = code.slice(temp, begin);
    // aggregate counts only — never a customer row
    expect(inventory.match(/SELECT /g)!.length).toBe(inventory.match(/COUNT\(\*\)/g)!.length);
    expect(inventory).not.toMatch(/subject|body_text|to_email/);
  });

  it("ONE final SELECT after COMMIT with the fixed shape (check, ok, n), ordered by the outer ORDER BY", () => {
    const tail = code.slice(commit + "\nCOMMIT;".length);
    expect(tail.trim().startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(tail.trim().endsWith("ORDER BY sec, ord;")).toBe(true);
    // one statement: no semicolon but the last, outside string literals
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").match(/;\s*(?=\S)/g)).toBeNull();
    expect(tail).toContain("FROM notif_round_g_258_before");
  });

  it("a prosrc probe doubles every apostrophe inside its pattern", () => {
    expect(code).toContain("prosrc LIKE '%AND e.status <> ''not_emailed''%'");
    expect(code).toContain("prosrc LIKE '%NEW.status = ''not_emailed'' AND email_gate(NEW.org_id, NEW.to_user_id, NEW.event_type) IS DISTINCT FROM false%'");
  });
});

describe("20261258 — what it changes", () => {
  const code = stripComments(M);

  it("the status CHECK keeps queued, sending, sent, failed and suppressed and adds only not_emailed", () => {
    expect(code).toContain("CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'not_emailed'))");
    const base = stripComments(mig("20260529_phase_b_notifications.sql")).match(/CHECK \(status IN \(([^)]*)\)\)/)![1];
    expect(base.replace(/\s/g, "")).toBe("'queued','sending','sent','failed','suppressed'");
  });

  it("DRLS-16: record_email_delivery is SECURITY DEFINER with search_path pinned, refuses a session, EXECUTE for service_role only", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION record_email_delivery(", "\n$$;");
    expect(fn).toContain("LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("IF auth.uid() IS NOT NULL THEN");
    expect(code).toContain("REVOKE ALL ON FUNCTION record_email_delivery(text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;");
    expect(code).toContain("GRANT EXECUTE ON FUNCTION record_email_delivery(text, text, timestamptz, text) TO service_role;");
  });

  it("the trigger function is SECURITY DEFINER with search_path pinned, lets the service role through, and is revoked from every client role", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION enforce_email_delivery_record()", "\n$$;");
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(code).toContain("REVOKE ALL ON FUNCTION enforce_email_delivery_record() FROM PUBLIC, anon, authenticated;");
    expect(code).toContain("CREATE TRIGGER trg_email_delivery_record\nBEFORE INSERT OR UPDATE ON email_notifications\nFOR EACH ROW EXECUTE FUNCTION enforce_email_delivery_record();");
  });

  it("no policy is created or dropped; no table is created; no notification kind is added", () => {
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY/);
    expect(code).not.toMatch(/CREATE TABLE (?!.*TEMP)/);
    expect(code).not.toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(code).not.toMatch(/notification_kinds/);
  });

  it("the seven delivery columns are added nullable, IF NOT EXISTS", () => {
    for (const c of ["provider_message_id TEXT", "delivery_status TEXT", "delivery_detail TEXT", "delivered_at TIMESTAMPTZ", "bounced_at TIMESTAMPTZ", "complained_at TIMESTAMPTZ", "delivery_updated_at TIMESTAMPTZ"]) {
      expect(code, c).toContain(`ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS ${c};`);
    }
  });
});
