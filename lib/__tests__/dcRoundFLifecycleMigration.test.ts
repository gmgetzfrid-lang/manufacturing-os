// document-control Round F wave 2 — P3 LIFECYCLE: the shape of migrations
// 20261130 (DCK-8, publish_revision re-created from its NEWEST body —
// 20261105 — with a lineDiff proof) and 20261131 (the documents-table rails:
// DRLS-3, DRLS-14, DRLS-13, REV-14). There is no live database here: the
// probes' LIKE patterns are checked against the function bodies they will
// read, and the rails are transcribed and exercised (the fakeSupabase
// trigger pattern), each transcription pinned to the SQL it mirrors.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RESTORE_TABLE_ORDER } from "@/lib/dataRestore";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const M130 = mig("20261130_dc_roundF_publish_override_reason.sql");
const M131 = mig("20261131_dc_roundF_documents_rails.sql");
const M105 = mig("20261105_prj_roundG_intake_review_and_attempts.sql");

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
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
/** The text pg_proc.prosrc will hold: between `AS $$` and the closing `$$;`. */
const prosrcOf = (sql: string, fnHead: string) => {
  const fn = between(sql, fnHead, "\n$$;");
  return fn.slice(fn.indexOf("AS $$") + "AS $$".length, fn.length - "$$;".length);
};

/** Every `prosrc [NOT] LIKE '…'` probe in the final SELECT, grouped by the
 *  proname it reads, checked against that function's body: a probe that
 *  cannot match the body it reads would report false on a correct apply. */
function checkProsrcProbes(sql: string, bodies: Record<string, string>) {
  const tail = sql.slice(sql.lastIndexOf("\nCOMMIT;"));
  const segments = tail.split(/\nUNION ALL /);
  let checked = 0;
  for (const seg of segments) {
    const pn = seg.match(/FROM pg_proc WHERE proname = '(\w+)'/);
    if (!pn) continue;
    const body = bodies[pn[1]];
    expect(body, `no body for ${pn[1]}`).toBeDefined();
    for (const m of seg.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
      const pattern = m[2].replace(/''/g, "'");
      const frags = pattern.split("%").filter(Boolean);
      if (m[1]) expect(frags.every((f) => body.includes(f)), `NOT LIKE ${pattern} matches the body`).toBe(false);
      else for (const f of frags) expect(body.includes(f), `probe fragment not in ${pn[1]}: ${f}`).toBe(true);
      checked++;
    }
  }
  return checked;
}

function pasteProtocol(name: string, text: string, tempTable: string) {
  describe(`${name} — one script, inventory first, one final result set`, () => {
    it("the inventory TEMP TABLE is captured BEFORE the transaction; exactly one statement follows COMMIT", () => {
      const temp = text.indexOf(`CREATE TEMP TABLE ${tempTable}`);
      const begin = text.indexOf("\nBEGIN;");
      const commit = text.lastIndexOf("\nCOMMIT;");
      expect(temp).toBeGreaterThan(0);
      expect(temp).toBeLessThan(begin);
      expect(commit).toBeGreaterThan(begin);
      const tail = stripComments(text.slice(commit + "\nCOMMIT;".length)).replace(/'(?:[^']|'')*'/g, "''");
      expect((tail.match(/;/g) ?? []).length).toBe(1);
      expect(tail.trim().startsWith("SELECT")).toBe(true);
    });
    it("the final SELECT has the fixed (check text, ok boolean, n text) shape; inventory rows are aggregate counts only", () => {
      const tail = text.slice(text.lastIndexOf("\nCOMMIT;"));
      expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
      expect(tail).toMatch(new RegExp(`UNION ALL SELECT inventory, NULL::boolean, n FROM ${tempTable};`));
      const inv = between(text, `CREATE TEMP TABLE ${tempTable}`, "\nBEGIN;");
      const selects = (inv.match(/^SELECT /gm) ?? []).length;
      expect((inv.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(selects);
      expect(tail).not.toMatch(/SELECT \*|SELECT id,|SELECT uid/);
    });
  });
}

pasteProtocol("20261130", M130, "dc_round_f_130_before");
pasteProtocol("20261131", M131, "dc_round_f_131_before");

// ─── 20261130 — DCK-8 ─────────────────────────────────────────────────────
describe("20261130 — publish_revision re-created from 20261105 with the DCK-8 override rules, nothing else moved", () => {
  const pub105 = between(M105, "CREATE OR REPLACE FUNCTION publish_revision(", "\n$$;");
  const pub130 = between(M130, "CREATE OR REPLACE FUNCTION publish_revision(", "\n$$;");

  it("lineDiff against 20261105: exactly the lock block, the new parameter and declarations, and the audit insert", () => {
    const { onlyInA, onlyInB } = lineDiff(pub105, pub130);
    expect(onlyInA).toEqual([
      "  p_override_lock BOOLEAN DEFAULT FALSE",
      "     AND v_doc.checked_out_by::text <> p_actor::text",
      "     AND NOT (p_override_lock OR (p_force AND v_is_controller)) THEN",
      "      'status', 'locked_by_other',",
      "      'holder_name', v_doc.checked_out_by_name",
    ]);
    const added = onlyInB.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
    expect(added).toEqual([
      "  p_override_lock BOOLEAN DEFAULT FALSE,",
      "  p_override_reason TEXT DEFAULT NULL",
      "  v_lock_via TEXT;",
      "  v_lock_holder TEXT;",
      "     AND v_doc.checked_out_by::text <> p_actor::text THEN",
      "    IF p_force AND v_is_controller THEN",
      "      v_lock_via := 'force';",
      "    ELSIF p_override_lock THEN",
      "      IF length(btrim(COALESCE(p_override_reason, ''))) < 5 THEN",
      "        RAISE EXCEPTION 'publish_revision: publishing over another user''s checkout needs a reason (at least 5 characters); it is shown to them and recorded.'",
      "      IF NOT v_is_controller",
      "         AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)",
      "         AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN",
      "        RAISE EXCEPTION 'publish_revision: only a publisher on this library (or the document''s owner) may publish over another user''s checkout.'",
      "      v_lock_via := 'override';",
      "    ELSE",
      "      RETURN jsonb_build_object(",
      "        'status', 'locked_by_other',",
      "        'holder_name', v_doc.checked_out_by_name",
      "      );",
      "    v_lock_holder := v_doc.checked_out_by::text;",
      "  IF v_lock_via IS NOT NULL THEN",
      "    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)",
      "    VALUES ('REV_LOCK_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,",
      "            (SELECT m.email FROM org_members m WHERE m.org_id = v_doc.org_id AND m.uid = p_actor LIMIT 1),",
      "            jsonb_build_object(",
      "              'via', v_lock_via,",
      "              'holder', v_lock_holder,",
      "              'holderName', v_doc.checked_out_by_name,",
      "              'reason', NULLIF(btrim(COALESCE(p_override_reason, '')), ''),",
      "              'versionId', v_new_id,",
      "              'revisionLabel', btrim(v_label),",
      "              'branch', p_as_branch",
      "            ));",
    ]);
  });

  it("the J1 revert-target word, the MOC gate, the branch-authority bar and the session-derived actor all survive", () => {
    expect(pub130).toContain("AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected', 'superseded')");
    expect(pub130).toContain("PSM requires an MOC reference to publish a non-minor revision of a drawing-class document");
    expect(pub130).toContain("branches included");
    expect(pub130).toContain("p_actor does not match the calling session");
    expect(pub130).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
  });

  it("the override order: a controller's force passes; an override needs the reason, then the eligibility; otherwise locked_by_other", () => {
    const lock = between(pub130, "  IF v_doc.checked_out_by IS NOT NULL\n     AND v_doc.checked_out_by::text <> p_actor::text THEN", "    v_lock_holder := v_doc.checked_out_by::text;");
    const force = lock.indexOf("IF p_force AND v_is_controller THEN");
    const reason = lock.indexOf("length(btrim(COALESCE(p_override_reason, ''))) < 5");
    const elig = lock.indexOf("AND NOT user_can_publish_on_library(");
    const locked = lock.indexOf("'status', 'locked_by_other'");
    expect(force).toBeGreaterThan(0);
    expect(reason).toBeGreaterThan(force);
    expect(elig).toBeGreaterThan(reason);
    expect(locked).toBeGreaterThan(elig);
    // the lock is still evaluated before the hold and the base
    expect(pub130.indexOf("v_lock_holder := v_doc.checked_out_by::text;")).toBeLessThan(pub130.indexOf("RETURN jsonb_build_object('status', 'on_hold');"));
    // the record is written only once the version exists (after the promote / branch insert)
    expect(pub130.indexOf("INSERT INTO audit_logs")).toBeGreaterThan(pub130.indexOf("RETURNING id INTO v_new_id;"));
    expect(pub130.indexOf("INSERT INTO audit_logs")).toBeLessThan(pub130.indexOf("SELECT to_jsonb(dv) INTO v_new_row"));
  });

  it("the 11-argument form is dropped BEFORE the 12-argument one is created; grants: authenticated + service_role, never PUBLIC or anon", () => {
    const drop = M130.indexOf("DROP FUNCTION IF EXISTS publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean);");
    expect(drop).toBeGreaterThan(M130.indexOf("\nBEGIN;"));
    expect(drop).toBeLessThan(M130.indexOf("CREATE OR REPLACE FUNCTION publish_revision("));
    expect(M130).toContain("REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) FROM PUBLIC, anon;");
    expect(M130).toContain("GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) TO authenticated, service_role;");
  });

  it("20261130 is the newest publish_revision; the publish guard is untouched (20261105 stays its newest body)", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const newest = (fn: RegExp) => files.filter((f) => fn.test(stripComments(mig(f)))).pop();
    expect(newest(/CREATE OR REPLACE FUNCTION publish_revision\(/)).toBe("20261130_dc_roundF_publish_override_reason.sql");
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/)).toBe("20261105_prj_roundG_intake_review_and_attempts.sql");
    expect(stripComments(M131)).not.toMatch(/FUNCTION (publish_revision|enforce_document_publish_guard|user_can_publish_on_library)\(/);
  });

  it("every prosrc probe can match the body it reads", () => {
    const n = checkProsrcProbes(M130, { publish_revision: prosrcOf(M130, "CREATE OR REPLACE FUNCTION publish_revision(") });
    expect(n).toBeGreaterThanOrEqual(10);
  });

  it("the app names the reason only when it overrides, with the same minimum the database enforces", () => {
    const r = readFileSync(join(process.cwd(), "lib/revisions.ts"), "utf8");
    expect((r.match(/\.\.\.\(lockedByOther \? \{ p_override_reason: input\.overrideReason\?\.trim\(\) \|\| null \} : \{\}\),/g) ?? []).length).toBe(2);
    expect(r).toMatch(/export const OVERRIDE_REASON_MIN = 5;/);
  });
});

// ─── 20261131 — the documents-table rails ─────────────────────────────────
const RAIL = prosrcOf(M131, "CREATE OR REPLACE FUNCTION enforce_document_register_rail()");
const SYNC = prosrcOf(M131, "CREATE OR REPLACE FUNCTION sync_current_version_label()");
const DEL = prosrcOf(M131, "CREATE OR REPLACE FUNCTION enforce_document_versions_pointer_rail()");
const WRITABLE = prosrcOf(M131, "CREATE OR REPLACE FUNCTION supersession_writable(p_org uuid, p_superseded uuid, p_replacement uuid)");
const INS = prosrcOf(M131, "CREATE OR REPLACE FUNCTION enforce_document_insert_pointer_rail()");

describe("20261131 — DRLS-3 / DRLS-14 register rail", () => {
  it("fires on exactly the register and pointer columns, BEFORE UPDATE", () => {
    expect(M131).toContain("CREATE TRIGGER trg_document_register_rail\n  BEFORE UPDATE OF rev, revision, document_number, effective_date, current_version_id, pending_version_id ON documents\n  FOR EACH ROW EXECUTE FUNCTION enforce_document_register_rail();");
  });
  it("pointer integrity binds EVERY caller (it comes before the service-role return); authority and consistency bind signed-in callers", () => {
    const ptr = RAIL.indexOf("current_version_id must name a revision of this document.");
    const pend = RAIL.indexOf("pending_version_id must name a revision of this document.");
    const svc = RAIL.indexOf("IF v_actor IS NULL THEN");
    const auth = RAIL.indexOf("AND NOT is_org_controller(NEW.org_id)");
    const cons = RAIL.indexOf("must match its current revision");
    expect(ptr).toBeGreaterThan(0);
    expect(pend).toBeGreaterThan(ptr);
    expect(svc).toBeGreaterThan(pend);
    expect(auth).toBeGreaterThan(svc);
    expect(cons).toBeGreaterThan(auth);
    expect(RAIL).toContain("WHERE v.id = NEW.current_version_id AND v.record_id = NEW.id");
    expect(RAIL).toContain("AND NOT user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)");
    expect(RAIL).toContain("AND NOT user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor)");
    expect(RAIL).toContain("v_promote := v_ptr_moved AND v_state = 'in_review' AND v_base <> '';");
  });
  it("a CURRENT revision's corrected label is carried onto the document (the other direction is a sync, not a refusal)", () => {
    expect(M131).toContain("CREATE TRIGGER trg_sync_current_version_label\n  AFTER UPDATE OF revision_label ON document_versions");
    expect(SYNC).toContain("WHERE current_version_id = NEW.id");
    expect(SYNC).toContain("AND (rev IS DISTINCT FROM NEW.revision_label OR revision IS DISTINCT FROM NEW.revision_label);");
  });
  it("deleting a document's current revision is refused at end of statement (NO ACTION timing); a pending pointer is cleared", () => {
    expect(M131).toMatch(/CREATE CONSTRAINT TRIGGER trg_document_versions_pointer_rail\n  AFTER DELETE ON document_versions\n  NOT DEFERRABLE INITIALLY IMMEDIATE\n  FOR EACH ROW EXECUTE FUNCTION enforce_document_versions_pointer_rail\(\);/);
    expect(DEL).toContain("IF EXISTS (SELECT 1 FROM documents d WHERE d.current_version_id = OLD.id) THEN");
    expect(DEL).toContain("UPDATE documents SET pending_version_id = NULL WHERE pending_version_id = OLD.id;");
  });
  it("DRLS-14: a signed-in INSERT is born with no pointers (BEFORE INSERT); the service role is exempt for the restore", () => {
    expect(M131).toContain("CREATE TRIGGER trg_document_insert_pointer_rail\n  BEFORE INSERT ON documents\n  FOR EACH ROW EXECUTE FUNCTION enforce_document_insert_pointer_rail();");
    expect(M131).toContain("CREATE OR REPLACE FUNCTION enforce_document_insert_pointer_rail()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const svc = INS.indexOf("IF auth.uid() IS NULL THEN\n    RETURN NEW;\n  END IF;");
    const refuse = INS.indexOf("IF NEW.current_version_id IS NOT NULL OR NEW.pending_version_id IS NOT NULL THEN");
    expect(svc).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(svc);
    expect(INS).toContain("USING ERRCODE = 'foreign_key_violation';");
  });
  it("REV-13: a pointer move copies the new current revision's effective date (every caller — before the service-role return); the caller's own date change is what the tier check reads", () => {
    const copy = RAIL.indexOf("NEW.effective_date := v_eff;");
    const svc = RAIL.indexOf("IF v_actor IS NULL THEN");
    const tier = RAIL.indexOf("OR v_eff_moved)");
    expect(copy).toBeGreaterThan(0);
    expect(copy).toBeLessThan(svc);
    expect(tier).toBeGreaterThan(svc);
    expect(RAIL).toContain("v_eff_moved boolean := NEW.effective_date IS DISTINCT FROM OLD.effective_date;");
    expect(RAIL).toContain("IF v_ptr_moved THEN\n    SELECT v.effective_date INTO v_eff\n      FROM document_versions v WHERE v.id = NEW.current_version_id;");
    expect(RAIL).toContain("IF v_eff IS NULL OR v_eff < (now() AT TIME ZONE 'UTC')::date - 1 THEN\n      NEW.effective_notified_at := now();\n    ELSE\n      NEW.effective_notified_at := NULL;\n    END IF;");
    // the DECLARE-time capture precedes the copy, so the tier check never sees the copy
    expect(RAIL).not.toContain("OR NEW.effective_date IS DISTINCT FROM OLD.effective_date)");
  });
  it("the version pointers are NOT declared FOREIGN KEYs — the restore replays documents before document_versions (the P3 LIFECYCLE decision)", () => {
    expect(stripComments(M131)).not.toMatch(/ALTER TABLE documents[^;]*REFERENCES/);
    expect(RESTORE_TABLE_ORDER.indexOf("documents")).toBeLessThan(RESTORE_TABLE_ORDER.indexOf("document_versions"));
    expect(M131).toMatch(/DEC-\d+ \(P3 LIFECYCLE; provisional number,\n--\s+renumbered on merge\) records the call\./);
  });
});

describe("20261131 — DRLS-14 evidence is preserved, never cascaded", () => {
  it("distribution_acks.version_id is re-added NO ACTION when its FK is anything else", () => {
    const blk = between(M131, "SELECT c.conname, c.confdeltype INTO v_con, v_del", "ON DELETE NO ACTION;");
    expect(blk).toContain("IF v_con IS NOT NULL AND v_del <> 'a' THEN");
    expect(blk).toContain("EXECUTE format('ALTER TABLE distribution_acks DROP CONSTRAINT %I', v_con);");
    expect(blk).toContain("FOREIGN KEY (version_id) REFERENCES document_versions(id) ON DELETE NO ACTION;");
  });
  it("acknowledgments and sign-offs gain their FK — NOT VALID only in the world where orphans exist", () => {
    for (const t of ["document_acknowledgments", "document_review_signoffs"]) {
      const blk = between(M131, `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${t}_version_fkey') THEN`, "  END IF;\n  END IF;");
      expect(blk).toContain("REFERENCES document_versions(id) ON DELETE NO ACTION NOT VALID;");
      expect(blk).toMatch(/ELSE\n\s*ALTER TABLE \w+\n\s*ADD CONSTRAINT \w+\n\s*FOREIGN KEY \(document_version_id\) REFERENCES document_versions\(id\) ON DELETE NO ACTION;/);
    }
    expect(stripComments(M131)).not.toMatch(/ON DELETE CASCADE/);
  });
  it("every FK this paste adds points at a table the restore replays BEFORE its child", () => {
    const fks = [...stripComments(M131).matchAll(/ALTER TABLE (\w+)\s+ADD CONSTRAINT \w+\s+FOREIGN KEY \(\w+\) REFERENCES (\w+)\(/g)].map((m) => ({ child: m[1], parent: m[2] }));
    expect(fks.length).toBe(5);
    for (const { child, parent } of fks) {
      expect(RESTORE_TABLE_ORDER.indexOf(parent), `${parent} restored`).toBeGreaterThanOrEqual(0);
      expect(RESTORE_TABLE_ORDER.indexOf(parent)).toBeLessThan(RESTORE_TABLE_ORDER.indexOf(child));
    }
  });
});

describe("20261131 — DRLS-13 / REV-14 supersession map", () => {
  it("the FOR ALL policy is dropped; SELECT stays member-wide; INSERT/UPDATE need supersession_writable; DELETE is controller-only", () => {
    const body = stripComments(M131);
    expect(body).toContain('DROP POLICY IF EXISTS "document_supersessions_member_all" ON document_supersessions;');
    expect(body).toMatch(/CREATE POLICY document_supersessions_select ON document_supersessions\n\s*FOR SELECT TO authenticated/);
    expect(body).toMatch(/CREATE POLICY document_supersessions_insert ON document_supersessions\n\s*FOR INSERT TO authenticated\n\s*WITH CHECK \(supersession_writable\(org_id, superseded_doc_id, replacement_doc_id\)\);/);
    expect(body).toMatch(/CREATE POLICY document_supersessions_update ON document_supersessions\n\s*FOR UPDATE TO authenticated\n\s*USING \(supersession_writable\(org_id, superseded_doc_id, replacement_doc_id\)\)\n\s*WITH CHECK \(supersession_writable\(org_id, superseded_doc_id, replacement_doc_id\)\);/);
    expect(body).toMatch(/CREATE POLICY document_supersessions_delete ON document_supersessions\n\s*FOR DELETE TO authenticated\n\s*USING \(is_org_controller\(org_id\)\);/);
    expect(body).not.toMatch(/CREATE POLICY [^;]*ON document_supersessions[^;]*FOR ALL/);
  });
  it("supersession_writable: an active member with publish authority on the SUPERSEDED document; both documents in the row's org", () => {
    expect(WRITABLE).toContain("m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active'");
    expect(WRITABLE).toContain("WHERE s.id = p_superseded AND s.org_id = p_org");
    expect(WRITABLE).toContain("OR user_can_publish_on_library(s.library_id, auth.uid()::text, s.org_id)");
    expect(WRITABLE).toContain("OR user_is_effective_owner(s.owner_user_id, s.collection_id, s.library_id, auth.uid())");
    expect(WRITABLE).toContain("WHERE r.id = p_replacement AND r.org_id = p_org");
    expect(M131).toContain("REVOKE ALL ON FUNCTION supersession_writable(uuid, uuid, uuid) FROM PUBLIC, anon;");
  });
  it("the pair index is built only where no unique pair index exists AND no duplicate pair exists (nothing is deleted)", () => {
    const blk = between(M131, "-- ── REV-14: one row per supersession pair", "END $$;");
    expect(blk).toContain("= ARRAY['replacement_doc_id', 'superseded_doc_id']");
    expect(blk).toContain("GROUP BY superseded_doc_id, replacement_doc_id HAVING COUNT(*) > 1");
    expect(blk).toContain("CREATE UNIQUE INDEX document_supersessions_pair_uniq");
    expect(stripComments(M131)).not.toMatch(/DELETE FROM document_supersessions/);
  });
  it("every function the paste creates is SECURITY DEFINER with search_path pinned", () => {
    for (const head of [
      "CREATE OR REPLACE FUNCTION enforce_document_register_rail()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$",
      "CREATE OR REPLACE FUNCTION sync_current_version_label()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$",
      "CREATE OR REPLACE FUNCTION enforce_document_versions_pointer_rail()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$",
      "CREATE OR REPLACE FUNCTION enforce_document_insert_pointer_rail()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$",
      "RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$",
    ]) expect(M131).toContain(head);
  });
  it("the inventories DEC-30 asks for are there: dangling pointers, rev ≠ current label, duplicate pairs", () => {
    const inv = between(M131, "CREATE TEMP TABLE dc_round_f_131_before", "\nBEGIN;");
    expect(inv).toMatch(/current_version_id names no revision \(DRLS-14 dangling\)/);
    expect(inv).toMatch(/pending_version_id names no revision \(DRLS-14 dangling\)/);
    expect(inv).toMatch(/rev differs from the current revision''s label \(DRLS-3/);
    expect(inv).toMatch(/duplicate document_supersessions pairs \(REV-14/);
    expect(inv).toMatch(/effective_date differs from their current revision''s \(REV-13/);
  });
  it("every prosrc probe can match the body it reads", () => {
    const n = checkProsrcProbes(M131, {
      enforce_document_register_rail: RAIL, sync_current_version_label: SYNC,
      enforce_document_versions_pointer_rail: DEL, supersession_writable: WRITABLE,
      enforce_document_insert_pointer_rail: INS,
    });
    expect(n).toBeGreaterThanOrEqual(12);
  });
});

// ─── The rails, transcribed and exercised ─────────────────────────────────
// Each transcription mirrors the SQL line for line; the pins below fail if
// the SQL moves without the transcription.

type Doc = { id: string; org_id: string; rev: string | null; revision: string | null; document_number: string | null; effective_date: string | null; effective_notified_at?: string | null; current_version_id: string | null; pending_version_id: string | null };
type Ver = { id: string; record_id: string; revision_label: string; base_rev?: string | null; review_state?: string | null; effective_date?: string | null };
type Ctx = { actor: string | null; publisher: boolean; versions: Ver[]; utcToday?: string };
const trim = (s: string | null | undefined) => (s ?? "").trim();
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** enforce_document_register_rail(), transcribed. Throws the RAISE; returns
 *  NEW as the trigger rewrites it (REV-13). */
function registerRail(NEW: Doc, OLD: Doc, ctx: Ctx): Doc {
  NEW = { ...NEW };
  const ptrMoved = NEW.current_version_id !== OLD.current_version_id;
  const revMoved = NEW.rev !== OLD.rev || NEW.revision !== OLD.revision;
  const effMoved = NEW.effective_date !== OLD.effective_date;
  const own = (vid: string) => ctx.versions.some((v) => v.id === vid && v.record_id === NEW.id);
  if (ptrMoved && NEW.current_version_id && !own(NEW.current_version_id)) throw new Error("current_version_id must name a revision of this document.");
  if (NEW.pending_version_id !== OLD.pending_version_id && NEW.pending_version_id && !own(NEW.pending_version_id)) throw new Error("pending_version_id must name a revision of this document.");
  if (ptrMoved) {
    const eff = ctx.versions.find((v) => v.id === NEW.current_version_id)?.effective_date ?? null;
    NEW.effective_date = eff;
    const utcToday = ctx.utcToday ?? new Date().toISOString().slice(0, 10);
    NEW.effective_notified_at = eff === null || eff < dayBefore(utcToday) ? "now()" : null;
  }
  if (ctx.actor === null) return NEW;
  if ((revMoved || NEW.document_number !== OLD.document_number || effMoved) && !ctx.publisher) {
    throw new Error("Only a publisher on this library (or the document's owner) may change its revision label, number or effective date.");
  }
  if (NEW.current_version_id && (ptrMoved || revMoved)) {
    const v = ctx.versions.find((x) => x.id === NEW.current_version_id);
    if (v) {
      const label = trim(v.revision_label), base = trim(v.base_rev), promote = ptrMoved && v.review_state === "in_review" && base !== "";
      const revOk = trim(NEW.rev) === label || (promote && trim(NEW.rev) === base);
      const revisionBad = NEW.revision !== null && (ptrMoved || NEW.revision !== OLD.revision)
        && !(trim(NEW.revision) === label || (promote && trim(NEW.revision) === base));
      if (!revOk || revisionBad) throw new Error(`The document's revision label must match its current revision (Rev ${label}).`);
    }
  }
  return NEW;
}
/** enforce_document_insert_pointer_rail(), transcribed. */
function insertRail(NEW: Pick<Doc, "current_version_id" | "pending_version_id">, actor: string | null): void {
  if (actor === null) return;
  if (NEW.current_version_id !== null || NEW.pending_version_id !== null) {
    throw new Error("A new document is created without a current or pending revision; its first revision is attached once the document exists.");
  }
}
/** enforce_document_versions_pointer_rail(), transcribed. */
function deleteVersion(docs: Doc[], versionId: string): void {
  if (docs.some((d) => d.current_version_id === versionId)) throw new Error("This revision is a document's current revision and cannot be deleted");
  for (const d of docs) if (d.pending_version_id === versionId) d.pending_version_id = null;
}

/** The document_supersessions policies as 20261131 writes them, read from
 *  the SQL text and evaluated. Each atom is a predicate the migration uses;
 *  an expression outside them throws, so the test cannot pass on a policy it
 *  does not understand. */
type Actor = { activeMember: boolean; controller: boolean; publisherOn: Set<string> };
type SupRow = { org_id: string; superseded_doc_id: string; replacement_doc_id: string };
const POLICY_ATOMS: Record<string, (a: Actor, r: SupRow) => boolean> = {
  "is_org_controller(org_id)": (a) => a.controller,
  "supersession_writable(org_id, superseded_doc_id, replacement_doc_id)": (a, r) =>
    a.activeMember && (a.controller || a.publisherOn.has(r.superseded_doc_id)),
  "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_supersessions.org_id AND m.uid = auth.uid() AND m.status = 'active')": (a) => a.activeMember,
};
function evalPolicyExpr(expr: string, a: Actor, r: SupRow): boolean {
  const e = expr.replace(/\s+/g, " ").trim();
  const atom = POLICY_ATOMS[e];
  if (atom) return atom(a, r);
  throw new Error(`unknown policy expression: ${e}`);
}
function supersessionPolicyAllows(cmd: string, a: Actor, r: SupRow): boolean {
  const body = stripComments(M131);
  const policies = [...body.matchAll(/CREATE POLICY (\w+) ON document_supersessions\s+FOR (\w+) TO authenticated\s+(?:USING \(([\s\S]*?)\))?\s*(?:WITH CHECK \(([\s\S]*?)\))?;/g)]
    .map((m) => ({ name: m[1], cmd: m[2], using: m[3], check: m[4] }));
  expect(policies.map((p) => p.cmd).sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  // permissive policies OR together; a command no policy names is refused
  return policies.filter((p) => p.cmd === cmd || p.cmd === "ALL").some((p) => {
    const u = p.using === undefined || evalPolicyExpr(p.using, a, r);
    const c = p.check === undefined || evalPolicyExpr(p.check, a, r);
    return cmd === "INSERT" ? c : cmd === "UPDATE" ? u && c : u;
  });
}

describe("the rails, exercised (transcriptions pinned to 20261131)", () => {
  it("the transcription's branches are the SQL's", () => {
    expect(RAIL).toContain("v_ptr_moved boolean := NEW.current_version_id IS DISTINCT FROM OLD.current_version_id;");
    expect(RAIL).toContain("v_rev_moved boolean := (NEW.rev IS DISTINCT FROM OLD.rev) OR (NEW.revision IS DISTINCT FROM OLD.revision);");
    expect(RAIL).toContain("OR NEW.document_number IS DISTINCT FROM OLD.document_number");
    expect(RAIL).toContain("OR v_eff_moved)");
    expect(RAIL).toContain("NEW.effective_date := v_eff;");
    expect(INS).toContain("IF NEW.current_version_id IS NOT NULL OR NEW.pending_version_id IS NOT NULL THEN");
    expect(RAIL).toContain("IF NEW.current_version_id IS NOT NULL AND (v_ptr_moved OR v_rev_moved) THEN");
    expect(RAIL).toContain("IF NOT (btrim(COALESCE(NEW.rev, '')) = v_label\n              OR (v_promote AND btrim(COALESCE(NEW.rev, '')) = v_base))");
    expect(RAIL).toContain("OR (NEW.revision IS NOT NULL\n             AND (v_ptr_moved OR NEW.revision IS DISTINCT FROM OLD.revision)");
  });

  const versions: Ver[] = [
    { id: "v3", record_id: "d1", revision_label: "3" },
    { id: "v4A", record_id: "d1", revision_label: "4A", base_rev: "4", review_state: "in_review" },
    { id: "other", record_id: "d2", revision_label: "9" },
  ];
  const base: Doc = { id: "d1", org_id: "o", rev: "3", revision: "3", document_number: "P-1", effective_date: null, current_version_id: "v3", pending_version_id: null };
  const member = { actor: "m", publisher: false, versions };
  const publisher = { actor: "p", publisher: true, versions };

  it("DRLS-3: an active member with no publish authority PATCHing rev is REFUSED — and document_number / effective_date the same", () => {
    expect(() => registerRail({ ...base, rev: "5", revision: "5" }, base, member)).toThrow(/Only a publisher/);
    expect(() => registerRail({ ...base, document_number: "P-2" }, base, member)).toThrow(/Only a publisher/);
    expect(() => registerRail({ ...base, effective_date: "2026-12-01" }, base, member)).toThrow(/Only a publisher/);
    // an unchanged register field (a metadata save re-sending the same rev) is not a change
    expect(() => registerRail({ ...base }, base, member)).not.toThrow();
  });
  it("DRLS-3: even a publisher cannot move the label off the file — rev must be the current revision's label", () => {
    expect(() => registerRail({ ...base, rev: "5", revision: "5" }, base, publisher)).toThrow(/must match its current revision \(Rev 3\)/);
    expect(() => registerRail({ ...base, document_number: "P-2" }, base, publisher)).not.toThrow();
  });
  it("a publish-shaped write (pointer + label together) passes; so does the review promote with the draft's base label", () => {
    const withV5: Ctx = { ...publisher, versions: [...versions, { id: "v5", record_id: "d1", revision_label: "5" }] };
    expect(() => registerRail({ ...base, current_version_id: "v5", rev: "5", revision: "5" }, base, withV5)).not.toThrow();
    expect(() => registerRail({ ...base, current_version_id: "v4A", rev: "4", revision: "4", pending_version_id: null }, { ...base, pending_version_id: "v4A" }, publisher)).not.toThrow();
    // …but not a mismatched promote
    expect(() => registerRail({ ...base, current_version_id: "v4A", rev: "7", revision: "7" }, base, publisher)).toThrow(/must match/);
  });
  it("DRLS-14: a pointer to another document's revision (or none) is refused — for the service role too", () => {
    const svc = { actor: null, publisher: false, versions };
    expect(() => registerRail({ ...base, current_version_id: "other" }, base, svc)).toThrow(/current_version_id must name a revision of this document/);
    expect(() => registerRail({ ...base, current_version_id: "ghost" }, base, publisher)).toThrow(/current_version_id must name/);
    expect(() => registerRail({ ...base, pending_version_id: "other" }, base, svc)).toThrow(/pending_version_id must name/);
    // the service role's label writes (restores, the intake door's promote) are the RPC's business
    expect(() => registerRail({ ...base, rev: "x" }, base, svc)).not.toThrow();
  });
  it("DRLS-14: a signed-in member INSERTing a document already pointing at another document's revision (or a dangling id) is REFUSED; the restore (service role) is not", () => {
    // the reviewer's case: status Issued, rev 5, current_version_id = another drawing's approved revision
    expect(() => insertRail({ current_version_id: "other", pending_version_id: null }, "m")).toThrow(/created without a current or pending revision/);
    expect(() => insertRail({ current_version_id: "ghost", pending_version_id: null }, "m")).toThrow(/created without/);
    expect(() => insertRail({ current_version_id: null, pending_version_id: "other" }, "m")).toThrow(/created without/);
    // every genuine creation flow inserts with no pointer, then attaches its first revision by UPDATE (publish guard + register rail)
    expect(() => insertRail({ current_version_id: null, pending_version_id: null }, "m")).not.toThrow();
    // the restore replays documents before their versions, as the service role
    expect(() => insertRail({ current_version_id: "v-restored-later", pending_version_id: null }, null)).not.toThrow();
    // and the app's creation paths really do insert without a pointer
    for (const f of ["lib/revisions.ts", "lib/documentLifecycle/common.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/\.from\("documents"\)\s*\.insert\(\{([\s\S]*?)\}\)/g)) {
        expect(m[1]).not.toMatch(/current_version_id|pending_version_id/);
      }
    }
  });
  it("REV-13: a pointer move by ANY door (the service-role intake auto-publish included) carries the new revision's effective date — a withdrawn revision's future date never outlives it", () => {
    const vs: Ver[] = [
      { id: "v4", record_id: "d1", revision_label: "4", effective_date: "2026-12-01" },
      { id: "v5", record_id: "d1", revision_label: "5", effective_date: null },
      { id: "v6", record_id: "d1", revision_label: "6", effective_date: "2026-10-02" },
      { id: "v7", record_id: "d1", revision_label: "7", effective_date: "2026-09-01" },
    ];
    const rev4: Doc = { ...base, rev: "4", revision: "4", current_version_id: "v4", effective_date: "2026-12-01", effective_notified_at: null };
    const svc: Ctx = { actor: null, publisher: false, versions: vs, utcToday: "2026-10-01" };
    // the reviewer's case: Rev 4 effective 1 Dec; a vendor submission auto-publishes Rev 5 (no date)
    const after5 = registerRail({ ...rev4, current_version_id: "v5", rev: "5", revision: "5" }, rev4, svc);
    expect(after5.effective_date).toBeNull();
    expect(after5.effective_notified_at).toBe("now()");
    // a date that may still be ahead in the facility's calendar is left for the scan to announce
    const after6 = registerRail({ ...rev4, current_version_id: "v6", rev: "6", revision: "6" }, rev4, { ...svc, actor: "p", publisher: true });
    expect(after6.effective_date).toBe("2026-10-02");
    expect(after6.effective_notified_at).toBeNull();
    // today in UTC (yesterday somewhere west) is not pre-stamped either — only a date past in every zone is
    expect(registerRail({ ...rev4, current_version_id: "v6", rev: "6", revision: "6" }, rev4, { ...svc, utcToday: "2026-10-02" }).effective_notified_at).toBeNull();
    expect(registerRail({ ...rev4, current_version_id: "v7", rev: "7", revision: "7" }, rev4, svc).effective_notified_at).toBe("now()");
    // the copy is not the caller's change: a pointer move that leaves the label alone (a re-pointed
    // same-label row) passes the register tier check even though the copy changed the date — pointer
    // authority is the publish guard's question, not this rail's
    const same: Ctx = { actor: "m", publisher: false, versions: [...vs, { id: "v4b", record_id: "d1", revision_label: "4", effective_date: null }], utcToday: "2026-10-01" };
    const moved = registerRail({ ...rev4, current_version_id: "v4b" }, rev4, same);
    expect(moved.effective_date).toBeNull();
    // …while the caller's OWN change to the date is refused for a non-publisher
    expect(() => registerRail({ ...rev4, effective_date: "2027-01-01" }, rev4, same)).toThrow(/Only a publisher/);
  });
  it("DRLS-14: deleting the revision a document names as current is REFUSED; deleting its pending draft clears the pointer", () => {
    const docs: Doc[] = [{ ...base, pending_version_id: "v4A" }];
    expect(() => deleteVersion(docs, "v3")).toThrow(/current revision and cannot be deleted/);
    deleteVersion(docs, "v4A");
    expect(docs[0].pending_version_id).toBeNull();
  });
  it("DRLS-13: the policies, evaluated from the SQL text — a Viewer's DELETE (and INSERT) of a supersession row is refused; a controller's DELETE and a publisher's INSERT pass; and the app treats zero rows as a failure", () => {
    const row = { org_id: "o", superseded_doc_id: "a", replacement_doc_id: "b" };
    const viewer: Actor = { activeMember: true, controller: false, publisherOn: new Set() };
    const publisherOfA: Actor = { activeMember: true, controller: false, publisherOn: new Set(["a"]) };
    const controller: Actor = { activeMember: true, controller: true, publisherOn: new Set() };
    const outsider: Actor = { activeMember: false, controller: false, publisherOn: new Set() };
    const can = (cmd: string, a: Actor) => supersessionPolicyAllows(cmd, a, row);
    expect(can("DELETE", viewer)).toBe(false);
    expect(can("DELETE", publisherOfA)).toBe(false);
    expect(can("DELETE", controller)).toBe(true);
    expect(can("INSERT", viewer)).toBe(false);
    expect(can("INSERT", publisherOfA)).toBe(true);
    expect(can("UPDATE", viewer)).toBe(false);
    expect(can("SELECT", viewer)).toBe(true);
    expect(can("SELECT", outsider)).toBe(false);
    // the evaluator refuses an expression it does not know, so widening a
    // policy (e.g. DELETE to every active member) changes these answers or
    // fails here — never passes silently
    expect(() => evalPolicyExpr("auth.uid() IS NOT NULL", viewer, row)).toThrow(/unknown policy expression/);
    const rev = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    // review fix 3: a lineage row left behind stops the reversal's saga (which
    // then puts every document back and re-links what was removed)
    expect(rev).toMatch(/if \(error \|\| remaining > 0\) \{\n\s*throw new Error\(`Reversal stopped: \$\{remaining \|\| "the"\} supersession link\(s\) could not be removed/);
    const common = readFileSync(join(process.cwd(), "lib/documentLifecycle/common.ts"), "utf8");
    expect(common).toMatch(/if \(delErr \|\| remaining > 0\) \{/);
  });
});
