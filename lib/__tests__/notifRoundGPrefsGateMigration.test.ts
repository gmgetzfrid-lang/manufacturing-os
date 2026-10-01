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
//     member, and is executable by authenticated + service_role only;
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
    expect(before).not.toMatch(/to_email|subject|body_text|body_html/);
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
      /CREATE OR REPLACE FUNCTION email_gate\(p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text DEFAULT NULL\)\s*RETURNS boolean\s*LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/,
    );
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

  it("the dedupe keys on (recipient, resource, event, org) inside 60 s, and never dedupes a resource-less email", () => {
    expect(body).toMatch(/IF p_resource_id ~\* '\^\[0-9a-f\]\{8\}-/);
    const dedupe = body.slice(body.indexOf("FROM email_notifications e"), body.indexOf("RETURN false;", body.indexOf("FROM email_notifications e")));
    for (const t of ["e.to_user_id = p_to_user", "e.resource_id = v_resource", "e.event_type = p_event_type", "e.org_id = p_org", "e.created_at >= now() - interval '60 seconds'"]) {
      expect(dedupe).toContain(t);
    }
  });

  it("EXECUTE is revoked from PUBLIC and anon and granted to authenticated and service_role, after the CREATE", () => {
    const created = tx.indexOf("CREATE OR REPLACE FUNCTION email_gate");
    const revoke = tx.indexOf("REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text) FROM PUBLIC, anon;");
    const grant = tx.indexOf("GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text) TO authenticated, service_role;");
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
    expect(pos.length).toBeGreaterThanOrEqual(6);
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
