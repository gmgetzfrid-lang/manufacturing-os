// Phase 6 severity sweep, Round B — migration shape tests for 20261046
// (authority by the collection, deny-wins publish, terminal-status guard,
// role sync, owner RPC grant) and 20261047 (acknowledgment / sign-off rails,
// project roster roles, honest mail queue, hold origin). Re-created bodies are
// line-diffed against their live predecessors so nothing is silently removed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const m46 = read("20261046_rp_phase6_sweep_authority_by_collection.sql");
const m47 = read("20261047_rp_phase6_sweep_integrity_rails.sql");
const m40 = read("20261040_rp_phase5_additive_publish_path.sql");
const m45 = read("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");
const m30 = read("20261030_dc_phase4_review_gate.sql");
const m16 = read("20260816_documents_access_change_guard.sql");
const m31 = read("20260831_capability_policy_and_rails.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from); if (a < 0) throw new Error(`anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length); if (b < 0) throw new Error(`end not found after ${from}: ${to}`);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const nonBlank = (ls: string[]) => ls.filter((l) => l.trim() !== "");

describe("probe hygiene (both migrations)", () => {
  it("policy probes never carry a bare cast; prosrc probes escape intra-literal apostrophes as a pair", () => {
    for (const m of [m46, m47]) {
      const v = m.slice(m.indexOf("── Verification"));
      for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) {
        expect(x[1], x[1]).not.toMatch(/\w::\w/);
        expect(x[1], x[1]).not.toMatch(/\]::\w+\[\]/);
      }
      for (const x of v.matchAll(/prosrc (?:NOT )?LIKE '((?:[^']|'')*)'/g)) {
        const unescaped = x[1].replace(/''/g, "'");
        if (/[A-Za-z]'[A-Za-z]/.test(unescaped)) expect(x[1], x[1]).toMatch(/[A-Za-z]''''[A-Za-z]/);
      }
    }
  });
  it("both end their DDL with COMMIT before verification, and carry a pre-apply inventory", () => {
    for (const m of [m46, m47]) {
      expect(m.indexOf("COMMIT;")).toBeLessThan(m.indexOf("── Verification"));
      expect(m).toMatch(/── Inventory \(read-only, aggregate\) — run BEFORE the DDL/);
    }
  });
});

describe("20261046 — authority by the collection", () => {
  it("is_org_admin, the teams policies, orgs_admin_write and checkout_messages read the collection", () => {
    expect(between(m46, "CREATE OR REPLACE FUNCTION is_org_admin", "$$;")).toMatch(/caller_holds_any_role\(p_org, ARRAY\['Admin'\]::text\[\]\)/);
    expect(between(m46, "CREATE POLICY teams_admin_write ON teams", ";")).toMatch(/caller_holds_any_role\(org_id, ARRAY\['Admin','Manager'\]::text\[\]\)/);
    expect(between(m46, "CREATE POLICY team_members_admin_write ON team_members", ";")).toMatch(/WITH CHECK \(caller_holds_any_role/);
    expect(between(m46, "CREATE POLICY orgs_admin_write ON orgs", ";")).toMatch(/caller_holds_any_role\(id, ARRAY\['Admin'\]::text\[\]\)/);
    expect(between(m46, "CREATE POLICY checkout_messages_own_update", ";")).toMatch(/user_id::text = auth\.uid\(\)::text\s*\n\s*OR caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl'\]::text\[\]\)/);
  });
  it("the eight side-table policies are rewritten in a loop over existing tables with their original role sets", () => {
    const blk = between(m46, "DO $$\nDECLARE\n  spec record;", "END $$;");
    for (const [t, roles] of [
      ["org_ai_instructions", "ARRAY['Admin','DocCtrl']"], ["document_related_resources", "ARRAY['Admin','DocCtrl','Manager','Supervisor']"],
      ["library_numbering", "ARRAY['Admin','DocCtrl']"], ["proposed_links", "ARRAY['Admin','DocCtrl','Manager','Supervisor']"],
      ["asset_aliases", "ARRAY['Admin','DocCtrl','Manager','Supervisor']"], ["codebook_entries", "ARRAY['Admin','DocCtrl']"],
      ["codebook_config", "ARRAY['Admin','DocCtrl']"], ["entity_mentions", "ARRAY['Admin','DocCtrl','Manager','Supervisor']"],
    ]) {
      expect(blk).toContain(`('${t}',`);
      expect(blk).toMatch(new RegExp(`\\('${t}',\\s+'${t}_write',\\s+${roles.replace(/[[\]]/g, (c) => "\\" + c)}\\)`));
    }
    expect(blk).toMatch(/IF to_regclass\('public\.' \|\| spec\.tbl\) IS NULL THEN CONTINUE; END IF;/);
    expect(blk).toMatch(/format\('caller_holds_any_role\(org_id, %L::text\[\]\)', spec\.roles\)/);
  });
  it("DEL-4: the supervisor swap is a controller act (BEFORE UPDATE guard on teams)", () => {
    const fn = between(m46, "CREATE OR REPLACE FUNCTION teams_guard_supervisor_change", "$$;");
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/NEW\.supervisor_user_id IS DISTINCT FROM OLD\.supervisor_user_id\s*\n\s*AND NOT is_org_controller\(OLD\.org_id\)/);
    expect(m46).toMatch(/CREATE TRIGGER teams_guard_supervisor\s*\n\s*BEFORE UPDATE ON teams/);
  });
  it("DOCACL-1: can_manage_node evaluates every held role for allow AND deny; nothing else changed", () => {
    const live = between(m16, "CREATE OR REPLACE FUNCTION can_manage_node", "$$;");
    const next = between(m46, "CREATE OR REPLACE FUNCTION can_manage_node", "$$;");
    expect(next).toMatch(/SELECT role, COALESCE\(roles, ARRAY\[role\]\) INTO v_role, v_roles FROM org_members/);
    expect(next).toMatch(/EXISTS \(SELECT 1 FROM unnest\(v_roles\) r WHERE acl_subject_has_action\(v_allow, 'admin', v_uid, r, v_teams, v_org\)\)/);
    expect(next).toMatch(/NOT EXISTS \(SELECT 1 FROM unnest\(v_roles\) r WHERE acl_subject_has_action\(v_deny, 'managePermissions', v_uid, r, v_teams, v_org\)\)/);
    expect(next).toMatch(/SET search_path = public/);
    // Only the headline read, the two allow/deny tests and the header line changed.
    const { onlyInA } = lineDiff(live, next);
    expect(nonBlank(onlyInA).map((l) => l.trim())).toEqual([
      "RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$",
      "SELECT role INTO v_role FROM org_members",
      "-- 'admin' allow wins unless 'admin' denied (matches acl.ts can()).",
      "IF acl_subject_has_action(v_allow, 'admin', v_uid, v_role, v_teams, v_org)",
      "AND NOT acl_subject_has_action(v_deny, 'admin', v_uid, v_role, v_teams, v_org) THEN",
      "-- 'managePermissions' allow unless denied.",
      "IF acl_subject_has_action(v_allow, 'managePermissions', v_uid, v_role, v_teams, v_org)",
      "AND NOT acl_subject_has_action(v_deny, 'managePermissions', v_uid, v_role, v_teams, v_org) THEN",
    ]);
  });
  it("the last-admin invariant counts collection-held Admins", () => {
    const next = between(m46, "CREATE OR REPLACE FUNCTION prevent_last_admin_removal", "$$;");
    expect(next).toMatch(/v_old_admin := OLD\.status = 'active' AND \(OLD\.role = 'Admin' OR OLD\.roles && ARRAY\['Admin'\]::text\[\]\);/);
    expect(next).toMatch(/AND \(role = 'Admin' OR roles && ARRAY\['Admin'\]::text\[\]\);/);
    expect(next).toMatch(/last active Admin — assign another Admin/);
    // The triggers keep their names, so replacing the function is enough.
    expect(m31).toMatch(/CREATE TRIGGER trg_prevent_last_admin_update/);
    expect(m46).not.toMatch(/CREATE TRIGGER trg_prevent_last_admin/);
  });
  it("OWN-8: user_can_publish_on_library gates the admin arms on no admin deny; everything else is the 20261040 body", () => {
    const live = between(m40, "CREATE OR REPLACE FUNCTION user_can_publish_on_library", "$$;");
    const next = between(m46, "CREATE OR REPLACE FUNCTION user_can_publish_on_library", "$$;");
    expect(next).toMatch(/v_admin_denied :=/);
    expect(next).toMatch(/OR \(NOT v_admin_denied AND \(v_idx->'allow'->'users'->'admin'\) \? p_uid\)/);
    expect(next).toMatch(/OR \(NOT v_admin_denied AND \(v_idx->'allow'->'roles'->'admin'\) \? r\)\)/);
    expect(next).toMatch(/OR \(NOT v_admin_denied AND \(v_idx->'allow'->'teams'->'admin'\) \? t\)\)\),/);
    const { onlyInA } = lineDiff(live, next);
    expect(nonBlank(onlyInA).map((l) => l.trim())).toEqual([
      "-- Allowed if granted \"publish\" OR \"admin\" to the user, ANY held role, or a team.",
      "OR (v_idx->'allow'->'users'->'admin')   ? p_uid",
      "OR (v_idx->'allow'->'roles'->'admin')   ? r)",
      "OR (v_idx->'allow'->'teams'->'admin')   ? t)),",
    ]);
  });
  it("OWN-15: the publish guard is the 20261045 body plus ONLY the terminal-status disjunct", () => {
    const live = between(m45, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    const next = between(m46, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "-- ── 4. DEL-9");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    // The only line that "left" is the old last disjunct, which now continues
    // (its terminating semicolon moved to the new disjunct).
    expect(nonBlank(onlyInA).map((l) => l.trim())).toEqual([
      "OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded');",
    ]);
    expect(nonBlank(onlyInB).map((l) => l.trim())).toEqual([
      "OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')",
      "-- OWN-15: un-supersede, unarchive and un-void are publish-shaped acts —",
      "-- the same authority that put the record there takes it back out.",
      "OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status);",
    ]);
  });
  it("ADD-5: the sync trigger mirrors ROLE_RANK exactly and keeps headline ∈ roles = max-rank", () => {
    const rank = between(m46, "CREATE OR REPLACE FUNCTION role_rank", "$$;");
    const ts = readFileSync(join(process.cwd(), "lib/roleCapabilities.ts"), "utf8");
    const tsRank = between(ts, "const ROLE_RANK: Record<Role, number> = {", "};");
    for (const m of tsRank.matchAll(/^\s*"?([A-Za-z-]+)"?:\s*(\d+),/gm)) {
      expect(rank, m[1]).toContain(`WHEN '${m[1]}' THEN ${m[2]}`);
    }
    const fn = between(m46, "CREATE OR REPLACE FUNCTION org_members_sync_role_collection", "$$;");
    expect(fn).toMatch(/NEW\.roles := ARRAY\[NEW\.role\];/);
    expect(fn).toMatch(/NEW\.roles := NEW\.roles \|\| ARRAY\[NEW\.role\];/);
    expect(fn).toMatch(/ORDER BY role_rank\(r\) DESC, r ASC LIMIT 1;/);
    expect(m46).toMatch(/CREATE TRIGGER trg_org_members_sync_roles\s*\n\s*BEFORE INSERT OR UPDATE OF role, roles ON org_members/);
    // Sorts before the last-admin trigger (alphabetical BEFORE-trigger order).
    expect("trg_org_members_sync_roles" < "trg_prevent_last_admin_update").toBe(true);
  });
  it("DEL-9: user_is_effective_owner is granted to authenticated", () => {
    expect(m46).toMatch(/GRANT EXECUTE ON FUNCTION user_is_effective_owner\(uuid, uuid, uuid, uuid\) TO authenticated;/);
  });
  it("verification counts 12 probes; inventory has five aggregate lines and runs before the DDL", () => {
    expect(m46).toMatch(/expect true × 12/);
    const inv = m46.slice(m46.indexOf("── Inventory"));
    expect((inv.match(/UNION ALL/g) ?? []).length).toBe(4);
    expect(inv).not.toMatch(/role_rank\(|trg_org_members_sync_roles|teams_guard_supervisor/);
  });
});

describe("20261047 — integrity rails", () => {
  it("SURF-12: INSERT mints only a pending unsigned row; the guard is the assignee's own act, signature-bound, no self-waiver, no edits", () => {
    const pol = between(m47, "CREATE POLICY doc_ack_insert ON document_acknowledgments", ";");
    expect(pol).toMatch(/AND status = 'pending' AND signature_id IS NULL AND acknowledged_at IS NULL/);
    const fn = between(m47, "CREATE OR REPLACE FUNCTION enforce_document_ack_guard", "$$;");
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF OLD\.assignee_user_id::text <> auth\.uid\(\)::text THEN/);
    expect(fn).toMatch(/e\.signer_user_id::text = auth\.uid\(\)::text/);
    expect(fn).toMatch(/You cannot waive your own acknowledgment\./);
    expect(fn).toMatch(/A recorded acknowledgment cannot be altered\./);
    expect(m47).toMatch(/CREATE TRIGGER trg_document_ack_guard\s*\nBEFORE UPDATE ON document_acknowledgments/);
  });
  it("SURF-13: the sign-off guard is the 20261030 body plus the reviewer_name pin and the signing-only signature rule", () => {
    const live = between(m30, "CREATE OR REPLACE FUNCTION enforce_review_signoff_guard", "$$;");
    const next = between(m47, "CREATE OR REPLACE FUNCTION enforce_review_signoff_guard", "$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(nonBlank(onlyInA)).toEqual([]);
    expect(nonBlank(onlyInB).map((l) => l.trim())).toEqual([
      "OR NEW.reviewer_name      IS DISTINCT FROM OLD.reviewer_name",
      "-- SURF-13: a signature is attached only by the act of signing.",
      "IF NEW.signature_id IS DISTINCT FROM OLD.signature_id AND NEW.status IS DISTINCT FROM 'signed' THEN",
      "RAISE EXCEPTION 'A signature can only be attached to a review row by signing it.'",
    ]);
  });
  it("SURF-11: roster roles decide management; roster helpers require an active membership; search_path pinned", () => {
    const cm = between(m47, "CREATE OR REPLACE FUNCTION can_manage_project", "$$;");
    expect(cm).toMatch(/COALESCE\(pm\.role, 'collaborator'\) IN \('owner', 'collaborator'\)/);
    expect(cm).toMatch(/caller_holds_any_role\(p\.org_id, ARRAY\['Admin','Manager'\]::text\[\]\)/);
    expect(cm).toMatch(/SET search_path = public/);
    for (const f of ["is_project_member", "is_project_owner"]) {
      expect(between(m47, `CREATE OR REPLACE FUNCTION ${f}`, "$$;")).toMatch(/om\.status = 'active'/);
    }
  });
  it("SURF-17 / SURF-18: the mail queue INSERT addresses a same-org member and is never external; SELECT own-or-admin; UPDATE confined", () => {
    const ins = between(m47, "CREATE POLICY email_notif_insert ON email_notifications", ";");
    expect(ins).toMatch(/COALESCE\(metadata->>'external', ''\) <> 'true'/);
    expect(ins).toMatch(/lower\(r\.email\) = lower\(email_notifications\.to_email\)/);
    const sel = between(m47, "CREATE POLICY email_notif_select_own_or_admin", ";");
    expect(sel).toMatch(/to_user_id = auth\.uid\(\) OR caller_holds_any_role\(org_id, ARRAY\['Admin','Manager'\]::text\[\]\)/);
    const guard = between(m47, "CREATE OR REPLACE FUNCTION enforce_email_requeue_columns", "$$;");
    expect(guard).toMatch(/to_jsonb\(NEW\) - 'status' - 'attempt_count' - 'updated_at'/);
  });
  it("LIFE-6: document_holds.origin_ticket_id with ON DELETE SET NULL and a partial open-holds index", () => {
    expect(m47).toMatch(/ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS origin_ticket_id UUID REFERENCES tickets\(id\) ON DELETE SET NULL;/);
    expect(m47).toMatch(/CREATE INDEX IF NOT EXISTS document_holds_origin_ticket_open_idx\s*\n\s*ON document_holds\(origin_ticket_id\) WHERE released_at IS NULL;/);
  });
  it("verification counts 10 probes incl. a 14-column late-binding probe; inventory has five lines", () => {
    expect(m47).toMatch(/expect true × 10/);
    const v = between(m47, "── Verification", "── Inventory");
    expect(v).toMatch(/COUNT\(\*\) = 14 FROM information_schema\.columns/);
    expect((v.match(/\('document_acknowledgments','[a-z_]+'\)/g) ?? []).length).toBe(7);
    const inv = m47.slice(m47.indexOf("── Inventory"));
    expect((inv.match(/UNION ALL/g) ?? []).length).toBe(4);
  });
});
