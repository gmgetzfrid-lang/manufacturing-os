// Roles-and-permissions Phase 5 — OWN-3 / DEC-2 at the database. Shape pins
// on 20261040 (four publish-path sites) and 20261041 (node_visible, landed
// separately), each assertion scoped to its own statement. The re-created
// bodies must be byte-faithful to their live predecessors EXCEPT for the
// controller substitution — proven by diffing against the source slices.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m40 = read("20261040_rp_phase5_additive_publish_path.sql");
const m41 = read("20261041_rp_phase5_node_visible_additive.sql");
const m36 = read("20261036_rp_phase3_publish_path.sql");
const m30 = read("20261030_dc_phase4_review_gate.sql");
const m37 = read("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

/** Lines of `a` that are not in `b` and vice versa — the substitution diff. */
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

describe("20261040 — enforce_document_publish_guard (site 1)", () => {
  const live = between(m30, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
  const next = between(m40, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "-- ── 2. per-library publish authority");

  it("routes the controller tier through is_org_controller and drops the headline read", () => {
    expect(next).toMatch(/IF is_org_controller\(NEW\.org_id\) THEN\s*\n\s*RETURN NEW;/);
    expect(next).not.toMatch(/v_role IN \('Admin', 'DocCtrl'\)/);
    expect(next).not.toMatch(/SELECT role INTO v_role/);
  });

  it("is otherwise byte-faithful to the live 20261030 body (only the controller block differs)", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    // Removed: the DECLARE line for v_role + the 7-line headline read/branch.
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([
      "  v_role         text;",
      "  SELECT role INTO v_role",
      "    FROM org_members",
      "   WHERE org_id = NEW.org_id AND uid::text = v_actor::text AND status = 'active'",
      "   LIMIT 1;",
      "  IF v_role IN ('Admin', 'DocCtrl') THEN",
    ]);
    // Added: the comment + the additive branch only.
    for (const l of onlyInB.filter((x) => x.trim() !== "")) {
      expect(l.trim().startsWith("--") || l.includes("is_org_controller(NEW.org_id)"), `unexpected new line: ${l}`).toBe(true);
    }
    // The review gate, hold check, and service pass survive.
    expect(next).toMatch(/e\.signer_user_id = s\.reviewer_user_id/);
    expect(next).toMatch(/Document has an active hold/);
    expect(next).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NEW;/);
    expect(next).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});

describe("20261040 — user_can_publish_on_library (site 2)", () => {
  const fn = between(m40, "CREATE OR REPLACE FUNCTION user_can_publish_on_library", "-- ── 3. publish_revision");

  it("reads the collection and short-circuits controllers by it", () => {
    expect(fn).toMatch(/SELECT role, COALESCE\(roles, ARRAY\[role\]\) INTO v_role, v_roles/);
    expect(fn).toMatch(/IF v_roles && ARRAY\['Admin','DocCtrl'\]::text\[\] THEN\s*\n\s*RETURN true;/);
    expect(fn).not.toMatch(/IF v_role IN \('Admin', 'DocCtrl'\)/);
  });

  it("role subjects match ANY held role — deny (CHAIN-1) and allow (ADD-1)", () => {
    expect(fn).toMatch(/EXISTS \(SELECT 1 FROM unnest\(v_roles\) r WHERE \(v_idx->'deny'->'roles'->'publish'\) \? r\)/);
    expect(fn).toMatch(/FROM unnest\(v_roles\) r\s*\n\s*WHERE \(v_idx->'allow'->'roles'->'publish'\) \? r\s*\n\s*OR \(v_idx->'allow'->'roles'->'admin'\)\s+\? r/);
    // The singular-role matches are gone entirely.
    expect(fn).not.toMatch(/\? v_role\b/);
  });

  it("keeps the deny-wins order, the team arms, and the no-index fallback", () => {
    expect(fn.indexOf("'deny'")).toBeLessThan(fn.indexOf("'allow'"));
    expect(fn).toMatch(/FROM team_members WHERE uid::text = p_uid AND org_id = p_org/);
    expect(fn).toMatch(/RETURN false;\s+-- no grants recorded/);
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});

describe("20261040 — publish_revision (site 3)", () => {
  const live = between(m36, "CREATE OR REPLACE FUNCTION publish_revision(", "GRANT EXECUTE ON FUNCTION publish_revision");
  const next = between(m40, "CREATE OR REPLACE FUNCTION publish_revision(", "GRANT EXECUTE ON FUNCTION publish_revision");

  it("v_is_controller is additive and stays inline on p_actor (service-role callers name their actor)", () => {
    expect(next).toMatch(/WHERE org_id = v_doc\.org_id AND uid = p_actor AND status = 'active'\s*\n\s*AND \(role IN \('Admin','DocCtrl'\) OR roles && ARRAY\['Admin','DocCtrl'\]::text\[\]\)\s*\n\s*\) INTO v_is_controller;/);
    expect(next).not.toMatch(/is_org_controller\(/);
  });

  it("is byte-faithful to the live 20261036 body except the controller SELECT", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["      AND role IN ('Admin','DocCtrl')"]);
    for (const l of onlyInB) {
      expect(l.trim().startsWith("--") || l.includes("roles && ARRAY['Admin','DocCtrl']::text[]"), `unexpected new line: ${l}`).toBe(true);
    }
    // OWN-5, DCK-1, REV-2 arms all survive.
    expect(next).toMatch(/p_actor does not match the calling session/);
    expect(next).toMatch(/branches included/);
    expect(next).toMatch(/OSHA 1910\.119\(l\)/);
    expect(next).toMatch(/revert target is an unreviewed draft/);
  });

  it("re-states the REVOKE/GRANT pair", () => {
    expect(m40).toMatch(/REVOKE ALL ON FUNCTION publish_revision\(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean\) FROM PUBLIC;/);
    expect(m40).toMatch(/GRANT EXECUTE ON FUNCTION publish_revision\(.*\) TO authenticated, service_role;/);
  });
});

describe("20261040 — sign-off / ack policies (site 4)", () => {
  it("all four policies are re-created on is_org_controller; owner + library-publisher arms kept", () => {
    for (const name of ["doc_review_signoff_update", "doc_review_signoff_delete", "doc_ack_update", "doc_ack_delete"]) {
      const pol = between(m40, `CREATE POLICY ${name} ON`, ";");
      expect(pol, name).toMatch(/is_org_controller\(/);
      expect(pol, name).not.toMatch(/role IN \('Admin','DocCtrl'\)/);
    }
    const upd = between(m40, "CREATE POLICY doc_review_signoff_update ON", ";");
    expect(upd).toMatch(/reviewer_user_id = auth\.uid\(\)/);
    expect(upd).toMatch(/user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)/);
    expect(upd).toMatch(/user_can_publish_on_library\(d\.library_id, auth\.uid\(\)::text, d\.org_id\)/);
    const ack = between(m40, "CREATE POLICY doc_ack_update ON", ";");
    expect(ack).toMatch(/assignee_user_id = auth\.uid\(\)/);
  });

  it("does NOT touch node_visible (DEC-2: lands last and separately)", () => {
    expect(m40).not.toMatch(/FUNCTION node_visible/);
  });

  it("verification + DEC-2 inventory ride the file, aggregate only", () => {
    const verify = between(m40, "── Verification", "── Inventory");
    expect(verify).toMatch(/enforce_document_publish_guard/);
    expect(verify).toMatch(/user_can_publish_on_library/);
    expect(verify).toMatch(/publish_revision/);
    expect(verify).toMatch(/doc_ack_delete/);
    const inv = m40.slice(m40.indexOf("── Inventory"));
    expect(inv).toMatch(/roles && ARRAY\['Admin','DocCtrl'\]::text\[\]\s*\n\s*AND role NOT IN \('Admin','DocCtrl'\)/);
    expect(inv).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT uid/);
    expect(inv).toMatch(/'allow'->'teams'->'publish'/);
  });
});

describe("20261041 — node_visible (site 5, separate)", () => {
  const live = between(m37, "CREATE OR REPLACE FUNCTION node_visible(\n  p_visibility text,\n  p_acl_index  jsonb,\n  p_org        uuid,\n  p_owner", "-- The 3-arg form stays");
  const next = between(m41, "CREATE OR REPLACE FUNCTION node_visible(", "COMMIT;");

  it("controller tier via is_org_controller, placed before the ownership branch", () => {
    expect(next).toMatch(/IF is_org_controller\(p_org\) THEN\s*\n\s*RETURN true;/);
    expect(next).not.toMatch(/IF v_role IN \('Admin', 'DocCtrl'\)/);
    expect(next.indexOf("is_org_controller(p_org)")).toBeLessThan(next.indexOf("user_is_effective_owner(p_owner"));
    // Fail-safe ordering: normal/unset visibility still returns first.
    expect(next.indexOf("p_visibility = 'normal'")).toBeLessThan(next.indexOf("is_org_controller(p_org)"));
  });

  it("allow-bucket role match evaluates every held role; deny-of-read/discover and teams untouched", () => {
    expect(next).toMatch(/SELECT 1 FROM unnest\(v_roles\) r\s*\n\s*WHERE acl_subject_in_bucket\(p_acl_index->'allow', v_uid, r, NULL::text\[\]\)/);
    expect(next).toMatch(/\(p_acl_index->'deny'->'users'->'read'\) \? v_uid/);
    expect(next).toMatch(/FROM team_members WHERE uid = auth\.uid\(\)/);
  });

  it("every line of the live 20261037 body survives except the headline controller block and the final RETURN", () => {
    const { onlyInA } = lineDiff(live, next);
    // Removed lines: the headline-only controller comment + SELECT + branch,
    // one reworded comment, and the single-role RETURN. The WHERE clause of
    // the member read survives verbatim (it now also fetches `roles`).
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([
      "  -- Controllers always see everything.",
      "  SELECT role INTO v_role FROM org_members",
      "  IF v_role IN ('Admin', 'DocCtrl') THEN",
      "  -- discover distinctions stay in the app layer.",
      "  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams);",
    ]);
  });

  it("does not redefine the 3-arg wrapper or doc_is_visible (they delegate to this body)", () => {
    expect(m41).not.toMatch(/FUNCTION doc_is_visible/);
    expect((m41.match(/CREATE OR REPLACE FUNCTION node_visible/g) ?? []).length).toBe(1);
    expect(next).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});
