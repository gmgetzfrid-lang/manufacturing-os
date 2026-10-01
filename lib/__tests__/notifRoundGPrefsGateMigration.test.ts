// notifications Round G, N1 PREFS-GATE — the shape of 20261148.
//
// There is no live database here (DEC-30: the user pastes the file into the
// Supabase SQL editor, which shows only the LAST result set). So the file is
// pinned textually:
//   * one script: the pre-apply inventory (aggregate COUNTs only, never a
//     row) in a TEMP table BEFORE the transaction, one BEGIN / COMMIT, and a
//     single final SELECT of (check, ok, n) rows;
//   * email_gate() is NEW (no earlier definition to carry byte-for-byte), is
//     STABLE SECURITY DEFINER with search_path pinned, refuses a NULL uid that
//     is not the service role and a signed-in caller who is not an active
//     member, and is executable by authenticated + service_role only; its
//     dedupe merges a repeat only (the latest email to the same recipient,
//     event and resource in 60 s, with the same subject AND body) — emit()'s
//     event_type is a category, so different messages share it, and some
//     differ only in the body (a recall naming the new current revision);
//     a recall / PSM alert passes every preference (DEC-44 (N1) §9);
//   * toast_enabled is added NOT NULL DEFAULT TRUE; inapp_enabled is marked
//     DEPRECATED and NOT dropped (integrator override: a dropped column cannot
//     be restored, and older backup envelopes carry it); push_enabled, the
//     digest_frequency CHECK and the policies are untouched;
//   * every prosrc probe in the final SELECT matches the body this file
//     creates (a probe that can never be true would report a false failure).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const FILE = "20261148_notif_roundG_prefs_gate.sql";
const raw = readFileSync(join(dir, FILE), "utf8");
const code = raw.replace(/--[^\n]*/g, "");

const beginAt = code.search(/^BEGIN;/m);
const commitAt = code.search(/^COMMIT;/m);
const before = code.slice(0, beginAt);
const tx = code.slice(beginAt, commitAt);
const after = code.slice(commitAt + "COMMIT;".length);
const body = (() => {
  const at = tx.indexOf("CREATE OR REPLACE FUNCTION email_gate");
  const open = tx.indexOf("AS $$", at) + "AS $$".length;
  return tx.slice(open, tx.indexOf("$$;", open));
})();

describe("20261148 — one paste, one result set (DEC-30)", () => {
  it("is the only file numbered 20261148, named in the round's pattern", () => {
    expect(readdirSync(dir).filter((f) => f.startsWith("20261148"))).toEqual([FILE]);
    expect(FILE).toMatch(/^20261148_notif_roundG_[a-z_]+\.sql$/);
  });

  it("opens with a header that names the findings, the widening, the deploy order and the paste rule", () => {
    const header = raw.slice(0, raw.indexOf("DROP TABLE IF EXISTS"));
    for (const t of ["DELIV-2", "DELIV-9", "RT-10", "WIDENING (DEC-30)", "DEPLOY ORDER", "APPLIED BY HAND (DEC-30)"]) {
      expect(header).toContain(t);
    }
  });

  it("captures the inventory in a TEMP table before BEGIN, then one BEGIN, one COMMIT, one statement after", () => {
    expect(before).toMatch(/DROP TABLE IF EXISTS notif_round_g_148_before;\s*CREATE TEMP TABLE notif_round_g_148_before AS/);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(after.split(";").filter((s) => s.trim())).toHaveLength(1);
  });

  it("the inventory counts and never selects a row: every sub-select is an aggregate COUNT", () => {
    // top-level sub-selects (an EXISTS (SELECT 1 …) inside a COUNT is a predicate, not a projection)
    const subs = [...before.matchAll(/(?<!EXISTS )\(SELECT\s+(\w+)/g)].map((m) => m[1]);
    expect(subs.length).toBeGreaterThanOrEqual(10);
    expect(new Set(subs)).toEqual(new Set(["COUNT"]));
    // message content is never read out: the subject and body appear only compared row to row
    const sql = before.replace(/'(?:[^']|'')*'/g, "''");
    expect(sql.replace(/\b[dex]\.(subject|body_text) (?:=|<>) [dex]\.\1\b/g, "")).not.toMatch(/to_email|subject|body_text|body_html/);
    // a true repeat: the same subject AND body; a different message between them is one that differs in either
    expect(sql).toMatch(/d\.subject = e\.subject AND d\.body_text = e\.body_text/);
    expect(sql).toMatch(/AND \(x\.subject <> e\.subject OR x\.body_text <> e\.body_text\)/);
  });

  it("the final SELECT is (check, ok, n): probes carry ok with n NULL, inventory carries n with ok NULL", () => {
    expect(after).toMatch(/^\s*SELECT '[^']+' AS check,[\s\S]*? AS ok,\s*NULL::text AS n\s*UNION ALL/);
    const branches = after.split(/\bUNION ALL\b/);
    expect(branches.length).toBeGreaterThanOrEqual(11);
    // every probe branch ends with a NULL n; the AFTER row and the TEMP rows carry NULL ok
    const probes = branches.filter((b) => !/NULL::boolean/.test(b));
    for (const b of probes) expect(b.trim()).toMatch(/NULL(::text)?(\s+AS n)?\s*$/);
    expect(branches.at(-1)!.trim()).toBe("SELECT inventory, NULL::boolean, n FROM notif_round_g_148_before;".replace(/;$/, "") + ";");
  });
});

describe("20261148 — email_gate()", () => {
  it("is new: no earlier migration (or the baseline) defines email_gate", () => {
    const earlier = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f) && f < FILE)
      .filter((f) => /FUNCTION\s+(?:public\.)?email_gate\b/i.test(readFileSync(join(dir, f), "utf8")));
    expect(earlier).toEqual([]);
    expect(readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8")).not.toMatch(/email_gate/);
  });

  it("is STABLE SECURITY DEFINER with search_path pinned, and returns boolean", () => {
    expect(tx).toMatch(
      /CREATE OR REPLACE FUNCTION email_gate\(p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text DEFAULT NULL, p_subject text DEFAULT NULL, p_body text DEFAULT NULL\)\s*RETURNS boolean\s*LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/,
    );
  });

  it("a paste of an earlier draft (four arguments; five, no body) is dropped first, so exactly one email_gate exists (and the probes count it)", () => {
    const created = tx.indexOf("CREATE OR REPLACE FUNCTION email_gate");
    for (const sig of ["email_gate(uuid, uuid, text, text);", "email_gate(uuid, uuid, text, text, text);"]) {
      const drop = tx.indexOf(`DROP FUNCTION IF EXISTS ${sig}`);
      expect(drop, sig).toBeGreaterThan(-1);
      expect(drop, sig).toBeLessThan(created);
    }
    expect(code.match(/DROP FUNCTION/g)).toHaveLength(2);
    expect(after).toMatch(/pg_get_function_identity_arguments\(p\.oid\) = 'p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text, p_subject text, p_body text'/);
    expect(after).toMatch(/WHERE n\.nspname = 'public' AND p\.proname = 'email_gate'\) = 1 AS ok,/);
  });

  it("a NULL uid passes only as the service role; a signed-in non-member is refused 42501", () => {
    expect(body).toMatch(/v_uid uuid := auth\.uid\(\);/);
    expect(body).toMatch(/IF v_uid IS NULL THEN\s*IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN\s*RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/);
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM org_members\s*WHERE org_id = p_org AND uid = v_uid AND status = 'active'\) THEN\s*RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/);
    // a member learns nothing about a person outside their org
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM org_members WHERE org_id = p_org AND uid = p_to_user\) THEN\s*RETURN true;/);
  });

  it("returns a boolean only — no column, row or address leaves the function", () => {
    expect(body.match(/RETURN [^;]+;/g)!.every((r) => /^RETURN (true|false);$/.test(r))).toBe(true);
  });

  it("the dedupe reads the LATEST email to (recipient, resource, event, org) inside 60 s and merges only when its subject AND body are this one's; never a resource-less email", () => {
    expect(body).toMatch(/IF p_resource_id ~\* '\^\[0-9a-f\]\{8\}-/);
    const dedupe = body.slice(body.indexOf("SELECT e.subject, e.body_text INTO v_last_subject, v_last_body"), body.indexOf("RETURN false;", body.indexOf("FROM email_notifications e")));
    expect(dedupe).toMatch(/^SELECT e\.subject, e\.body_text INTO v_last_subject, v_last_body\s+FROM email_notifications e\s+WHERE/);
    for (const t of ["e.to_user_id = p_to_user", "e.resource_id = v_resource", "e.event_type = p_event_type", "e.org_id = p_org", "e.created_at >= now() - interval '60 seconds'"]) {
      expect(dedupe).toContain(t);
    }
    expect(dedupe).toMatch(/ORDER BY e\.created_at DESC\s+LIMIT 1;\s*IF v_last_subject = p_subject AND v_last_body = p_body THEN\s*$/);
    expect(body).toMatch(/v_last_subject text;\s*v_last_body text;/);
    // a subject-only key merges a recall naming Rev C into the one naming Rev B
    expect(body).not.toMatch(/IF v_last_subject = p_subject THEN/);
    // a mere EXISTS on the key (any earlier email about the resource) would merge different messages
    expect(body).not.toMatch(/EXISTS \(SELECT 1 FROM email_notifications/);
  });

  it("a recall and a PSM alert skip the preference read entirely (the master switch and 'never' included); the dedupe still runs for them", () => {
    const exempt = body.indexOf("IF COALESCE(p_event_type, '') NOT IN ('safety_recall', 'safety_alert') THEN");
    expect(exempt).toBeGreaterThan(-1);
    const read = body.indexOf("SELECT * INTO v_prefs FROM notification_preferences WHERE user_id = p_to_user;");
    expect(body.slice(exempt, read)).toMatch(/THEN\s*$/);
    expect(body.indexOf("v_prefs.email_enabled IS FALSE")).toBeGreaterThan(read);
    // the exemption closes before the dedupe opens
    const dedupe = body.indexOf("IF p_resource_id ~*");
    expect(body.slice(body.indexOf("IF v_toggle IS FALSE THEN RETURN false; END IF;"), dedupe)).toMatch(/^IF v_toggle IS FALSE THEN RETURN false; END IF;\s*END IF;\s*END IF;\s*$/);
  });

  it("EXECUTE is revoked from PUBLIC and anon and granted to authenticated and service_role, after the CREATE", () => {
    const created = tx.indexOf("CREATE OR REPLACE FUNCTION email_gate");
    const revoke = tx.indexOf("REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;");
    const grant = tx.indexOf("GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;");
    expect(tx).toMatch(/COMMENT ON FUNCTION email_gate\(uuid, uuid, text, text, text, text\) IS/);
    expect(revoke).toBeGreaterThan(created);
    expect(grant).toBeGreaterThan(revoke);
  });
});

describe("20261148 — the columns", () => {
  it("adds toast_enabled BOOLEAN NOT NULL DEFAULT TRUE, idempotently", () => {
    expect(tx).toMatch(/ALTER TABLE notification_preferences\s+ADD COLUMN IF NOT EXISTS toast_enabled BOOLEAN NOT NULL DEFAULT TRUE;/);
  });

  it("keeps inapp_enabled: no DROP COLUMN anywhere; it is commented DEPRECATED, guarded on its existence", () => {
    expect(code).not.toMatch(/DROP\s+COLUMN/i);
    expect(tx).toMatch(/IF EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*?column_name = 'inapp_enabled'\) THEN\s*EXECUTE \$c\$COMMENT ON COLUMN notification_preferences\.inapp_enabled IS 'DEPRECATED/);
  });

  it("touches neither push_enabled, the digest_frequency CHECK, nor any policy", () => {
    expect(tx).not.toMatch(/push_enabled/);
    expect(tx).not.toMatch(/digest_frequency IN|CONSTRAINT|ALTER COLUMN/i);
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY|CREATE TRIGGER/i);
  });
});

describe("20261148 — the probes can be true", () => {
  /** A SQL string literal's value ('' → '), and a LIKE pattern as a regex. */
  const literal = (s: string) => s.replace(/''/g, "'");
  const like = (p: string) => new RegExp(literal(p).split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*"));

  it("every prosrc LIKE pattern matches the body this file creates, and every NOT LIKE does not", () => {
    const pos = [...after.matchAll(/p\.prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1]);
    const neg = [...after.matchAll(/p\.prosrc NOT LIKE '((?:[^']|'')*)'/g)].map((m) => m[1]);
    expect(pos.length).toBeGreaterThanOrEqual(9);
    expect(neg.length).toBe(2);
    for (const p of pos) expect(body, p).toMatch(like(p));
    for (const p of neg) expect(body, p).not.toMatch(like(p));
  });

  it("the deprecation probe matches the comment this file writes", () => {
    const comment = tx.match(/inapp_enabled IS '((?:[^']|'')*)'/)![1];
    expect(literal(comment)).toMatch(/^DEPRECATED/);
    expect(after).toMatch(/LIKE 'DEPRECATED%'/);
  });

  it("the CHECK probe reads the deparsed constraint without a cast in the pattern", () => {
    expect(after).toMatch(/pg_get_constraintdef\(c\.oid\) LIKE '%''instant''%''hourly''%''daily''%''never''%'/);
    expect(after).not.toMatch(/LIKE '[^']*::text/);
  });
});
