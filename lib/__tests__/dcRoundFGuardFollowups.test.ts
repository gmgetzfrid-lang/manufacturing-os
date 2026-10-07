// document-control Round F wave 3 — P17 GUARD & EDITOR FOLLOW-UPS:
// migration 20261159.
//
//   REV-22  enforce_document_publish_guard re-created from its NEWEST earlier
//           body (scan — 20261151 today) with EXACTLY the P17 lines added: a
//           controller's bare pointer move on a held document ALREADY in an
//           issue status passes the hold only under the recorded-force flag
//           (publish_revision's / finalize_reviewed_promote's), refused in
//           REV-20 (b)'s sentence otherwise. The unstamped Superseded exit
//           REV-20 (a) spares stays spared (the legacy reversal's put-back).
//   RG-14   the review completion gate (the per-slot count in the same guard)
//           refuses a roster stamped 'owner:<uid>' — opened under an
//           owner-must-approve policy — unless that slot group is filled by
//           that owner's own bound signature; the stamp is written by a new
//           BEFORE INSERT OR UPDATE trigger on document_review_signoffs from
//           a new policy helper (the twin of review_control_mode_for).
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the additions IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (cases in
// REV-22's and RG-14's records).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FILE = "20261159_dc_roundF_guard_owner_and_held_pointer.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
/** The one way a migration other than 20261151 may name the recorded-force flag: reading it —
 *  current_setting('app.publish_hold_override', true), in a body or quoted in a prosrc probe. */
const withoutFlagReads = (sql: string) => sql
  .split("current_setting('app.publish_hold_override', true)").join("")
  .split("current_setting(''app.publish_hold_override'', true)").join("");
/** Every file under a repository directory (repo-relative paths). */
function walk(rel: string): string[] {
  return readdirSync(join(process.cwd(), rel), { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name.startsWith(".") ? []
      : e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]);
}
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

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
/** The definition this migration re-creates from: the newest one BEFORE it (scanned). */
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };

/** The guard's four additions, as contiguous text. */
const G_DECL = "  v_unforced_move boolean;\n";
const G_MOVE = G.next.slice(
  G.next.indexOf("  -- REV-22 (document-control Round F wave 3, P17): REV-20 (b)'s recorded-"),
  G.next.indexOf("  v_advancing := v_advancing OR v_issuing;"),
);
const G_OWNER = G.next.slice(
  G.next.indexOf("\n    -- RG-14 (document-control Round F wave 3, P17): the owner-must-approve"),
  G.next.indexOf("\n    -- RG-7: an absent roster is not \"no gate\"."),
);
const G_REFUSE = G.next.slice(
  G.next.indexOf("  -- REV-22 (P17): a controller's pointer move over an active hold on a"),
  G.next.indexOf("  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION."),
);
const HOLD_SENTENCE = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const OWNER_SENTENCE = "This revision's review was opened under a policy that requires the document owner's approval, and the owner has not signed it; resubmit it for review so the owner is on its roster.";

describe("20261159 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261151 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261151_dc_roundF_promote_transaction_and_hold_override.sql").toBe(true);
  });

  it("nothing removed, every new line is one of the P17 additions, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = (G_DECL + G_MOVE + G_OWNER + G_REFUSE).split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    for (const part of [G_DECL, G_MOVE, G_OWNER, G_REFUSE]) {
      expect(part.length, part.slice(0, 60)).toBeGreaterThan(20);
      expect(G.next.split(part).length, part.slice(0, 60)).toBe(2);
    }
    expect(G.next.replace(G_DECL, "").replace(G_MOVE, "").replace(G_OWNER, "").replace(G_REFUSE, "")).toBe(G.live);
  });

  it("REV-22's added code is exactly the recorded-force rule for a controller's pointer move on an already-issued document (bound to a controller; a first pointer write excluded)", () => {
    expect(code((G_DECL + G_MOVE + G_REFUSE).split("\n"))).toEqual([
      "  v_unforced_move boolean;",
      "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL",
      "                              AND NEW.current_version_id IS NOT NULL",
      "                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
      "                              AND is_controlled_issue_status(OLD.status)",
      "                              AND is_controlled_issue_status(NEW.status)",
      "                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                              AND is_org_controller(NEW.org_id), false);",
      "  IF v_unforced_move AND EXISTS (",
      "       SELECT 1 FROM document_holds h",
      "        WHERE h.document_id = NEW.id AND h.released_at IS NULL",
      "     ) THEN",
      "    RAISE EXCEPTION",
      "      'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'",
      "      USING ERRCODE = 'check_violation';",
      "  END IF;",
    ]);
    // the decl right after REV-20's; the computation right after REV-20 (b)'s, from the same flag test
    expect(G.next).toContain("  v_unforced_issue boolean;\n" + G_DECL + "BEGIN\n");
    const unforcedIssue = "  v_unforced_issue := COALESCE(v_issuing\n                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n"
      + "                               AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n"
      + "                               AND is_org_controller(NEW.org_id), false);\n";
    expect(G.next).toContain(unforcedIssue + G_MOVE + "  v_advancing := v_advancing OR v_issuing;");
    // the refusal after the whole issue block (REV-18 / REV-20 decide first) and before the controller return
    expect(G.next.indexOf(G_REFUSE)).toBeGreaterThan(G.next.indexOf("'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'"));
    expect(G.next).toContain(G_REFUSE + "  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.\n  -- v_actor IS auth.uid() here (service-role returned above), so the shared\n  -- additive helper applies.\n  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;\n  END IF;");
  });

  it("REV-22's other half stays spared: REV-20 (a)'s limb is untouched (Archived / Void only — the legacy reversal's unstamped Superseded put-back keeps passing), and every P17 refusal needs a pointer move, which the reversal's status-only restore never makes", () => {
    expect(G.next).toContain("                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n");
    expect(G_MOVE + G_OWNER + G_REFUSE).not.toMatch(/'Superseded'/);
    // REV-22: the pointer moved; RG-14: inside the review gate, which runs only when the pointer moved
    expect(G_MOVE).toContain("AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id");
    const gateOpen = G.next.indexOf("  IF NEW.current_version_id IS NOT NULL\n     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN");
    expect(gateOpen).toBeGreaterThan(0);
    expect(G.next.indexOf(G_OWNER)).toBeGreaterThan(gateOpen);
    expect(G.next.indexOf(G_OWNER)).toBeLessThan(G.next.indexOf("  -- REV-18 (P13): the issue itself."));
    // the legacy reversal's restore is status-only (no pointer in its payload)
    const reverse = src("lib/documentLifecycle/reverse.ts");
    const restore = reverse.slice(reverse.indexOf("async function restoreStatus("), reverse.indexOf("/** Delete this operation's supersession rows"));
    expect(restore).toContain(".update({\n    status,\n    superseded_at: null,");
    expect(restore).not.toMatch(/current_version_id/);
  });

  it("RG-14's added code is exactly the owner-slot rule, right after the per-slot completion count", () => {
    expect(code(G_OWNER.split("\n"))).toEqual([
      "    IF EXISTS (",
      "         SELECT 1 FROM document_review_signoffs o",
      "          WHERE o.document_version_id = NEW.current_version_id",
      "            AND o.opened_owner_slot LIKE 'owner:%'",
      "            AND NOT EXISTS (",
      "              SELECT 1 FROM document_review_signoffs s",
      "               WHERE s.document_version_id = NEW.current_version_id",
      "                 AND s.slot_group = o.opened_owner_slot",
      "                 AND 'owner:' || s.reviewer_user_id::text = o.opened_owner_slot",
      "                 AND s.status = 'signed'",
      "                 AND s.signature_id IS NOT NULL",
      "                 AND EXISTS (",
      "                   SELECT 1 FROM e_signatures e",
      "                   WHERE e.id = s.signature_id",
      "                     AND e.signer_user_id = s.reviewer_user_id",
      "                     AND e.org_id = s.org_id",
      "                     AND (e.document_version_id = s.document_version_id",
      "                          OR e.document_version_id IS NULL)",
      "                 ))",
      "       ) THEN",
      "      RAISE EXCEPTION",
      "        'This revision''s review was opened under a policy that requires the document owner''s approval, and the owner has not signed it; resubmit it for review so the owner is on its roster.'",
      "        USING ERRCODE = 'check_violation';",
      "    END IF;",
    ]);
    expect(G.next).toContain("        'This revision still has outstanding review sign-offs; complete the review before publishing.'\n        USING ERRCODE = 'check_violation';\n    END IF;\n" + G_OWNER);
    // a signature binds exactly as the per-slot count binds it
    const slotCount = G.live.slice(G.live.indexOf("count(*) FILTER (WHERE (s.slot = 'primary' OR s.activated)"), G.live.indexOf(")) AS filled"));
    expect(slotCount).toContain("AND e.signer_user_id = s.reviewer_user_id\n");
    expect(slotCount).toContain("OR e.document_version_id IS NULL");
  });

  it("the refusals are said as the app reads them: REV-22's is REV-20 (b)'s (the inspector offers the controller the review promote's recorded force; elsewhere the hold is told), RG-14's is said as the database said it", async () => {
    const { isIssueRefusal, ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    const { isFinalizeHoldRefusal, finalizeReasonMessage } = await import("@/lib/reviewControl");
    const sqlSentences = [...M.matchAll(/'((?:Document has an active hold|This revision''s review was opened)[^']*(?:''[^']*)*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(sqlSentences).toContain(HOLD_SENTENCE);
    expect(sqlSentences).toContain(OWNER_SENTENCE);
    expect(mig(PREV)).toContain(HOLD_SENTENCE.replace("Control's", "Control''s"));
    expect(isIssueRefusal(HOLD_SENTENCE)).toBe(true);
    expect(HOLD_SENTENCE).toContain(ISSUE_REFUSAL.newDoorHold);
    expect(isFinalizeHoldRefusal(HOLD_SENTENCE)).toBe(true);
    expect(finalizeReasonMessage(HOLD_SENTENCE)).toBe("This document has an active hold, so the reviewed revision was not published and nothing was changed. Release the hold, then publish the reviewed revision — its sign-offs stand.");
    expect(isFinalizeHoldRefusal(OWNER_SENTENCE)).toBe(false);
    expect(finalizeReasonMessage(OWNER_SENTENCE)).toBe(`Couldn't publish: ${OWNER_SENTENCE}`);
    // the inspector offers a controller the force on exactly the hold refusal
    const panel = src("components/documents/ReviewGateSection.tsx");
    expect(panel).toContain("if (!forceHold && isController && isFinalizeHoldRefusal(res.reason)) {");
  });

  it("the flag is still SET only by publish_revision and finalize_reviewed_promote (20261151) — and, since P18, the reversal's restore_reversed_source (20261164); this guard only reads it", () => {
    // every other migration may only READ it — the exact read current_setting('app.publish_hold_override', true);
    // with those reads stripped, no mention of the flag may remain (no SET LOCAL, no set_config in any spelling)
    for (const f of files) {
      if (f === "20261151_dc_roundF_promote_transaction_and_hold_override.sql") continue;
      // REV-22 (P18): 20261164's restore_reversed_source is the one other setter (the legacy
      // reversal's recorded put-back) — pinned in dcRoundFReversalRestore.test.ts.
      if (f === "20261164_dc_roundF_reversal_restore.sql") continue;
      // REV-23 (P19): and 20261165's put_back_retired_issue (the stamped put-back's recorded
      // door) — pinned in dcRoundFStampedPutBackMigration.test.ts.
      if (f === "20261165_dc_roundF_stamped_put_back.sql") continue;
      expect(withoutFlagReads(stripComments(mig(f))), f).not.toMatch(/publish_hold_override/);
    }
    expect(withoutFlagReads("SET LOCAL app.publish_hold_override = p_doc::text;")).toMatch(/publish_hold_override/);
    expect(withoutFlagReads("PERFORM set_config( 'app.publish_hold_override', v, true);")).toMatch(/publish_hold_override/);
    expect(stripComments(G.next).match(/app\.publish_hold_override/g)).toHaveLength(2); // REV-20 (b) and REV-22, both current_setting
    expect(stripComments(G.next)).not.toMatch(/set_config/);
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION/);
    expect(stripComments(M)).not.toMatch(/GRANT /);
  });
});

describe("20261159 — RG-14: the opened-under stamp and the policy helper", () => {
  const HELPER_HEAD = "CREATE OR REPLACE FUNCTION review_control_owner_must_approve_for(";
  const STAMP_HEAD = "CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()";
  const H = between(M, HELPER_HEAD, "\n$$;");
  const S = between(M, STAMP_HEAD, "\n$$;");

  it("both functions and the trigger are new (no earlier migration names them) — nothing else is re-created", () => {
    for (const f of files.filter((x) => x < FILE)) {
      const s = stripComments(mig(f));
      expect(s, f).not.toMatch(/review_control_owner_must_approve_for|review_signoff_owner_stamp|trg_review_signoff_owner_stamp|opened_owner_slot/);
    }
    expect([...stripComments(M).matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1])).toEqual([
      "review_control_owner_must_approve_for", "review_signoff_owner_stamp", "enforce_document_publish_guard",
    ]);
  });

  it("the helper is the twin of the NEWEST review_control_mode_for: the same chain (document → folder → ancestors nearest first → library), reading ownerMustApprove as JSON true", () => {
    const modeFiles = files.filter((f) => /CREATE OR REPLACE FUNCTION review_control_mode_for\(/.test(stripComments(mig(f))));
    const mode = between(mig(modeFiles[modeFiles.length - 1]), "CREATE OR REPLACE FUNCTION review_control_mode_for(", "\n$$;");
    const twin = mode
      .replace("review_control_mode_for(", "review_control_owner_must_approve_for(")
      .replace("RETURNS text", "RETURNS boolean")
      .split("->>'mode', 'none')").join("->'ownerMustApprove' = 'true'::jsonb, false)")
      .replace("    'none');", "    false);");
    expect(H).toBe(twin);
    expect(H).toContain("RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$");
    expect(H).not.toMatch(/SECURITY DEFINER/);
    expect(M).toContain("REVOKE ALL ON FUNCTION review_control_owner_must_approve_for(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;");
    // the app reads the same flag the same way (=== true on the effective, nearest-defined policy)
    expect(src("lib/reviewControl.ts")).toContain("if (input.control.ownerMustApprove === true) {");
    expect(src("lib/reviewControl.ts")).toContain("return firstDefinedInChain(chain, (v): v is ReviewControl => !!v) ?? NONE;");
  });

  it("the stamp: the service role trusted; a signed-in UPDATE keeps it; a row added to an open roster takes its stamp; a roster's first row is stamped from the DRAFT's own document with placeOwnerSlot's outcomes", () => {
    expect(S).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(S).toContain("  IF auth.uid() IS NULL THEN\n    RETURN NEW;\n  END IF;");
    expect(S).toContain("  IF TG_OP = 'UPDATE' THEN\n    NEW.opened_owner_slot := OLD.opened_owner_slot;\n    RETURN NEW;\n  END IF;");
    // the opened-under rule: an open roster's rows decide (NULL — opened before the paste — included), before anything is read
    expect(S).toContain("  SELECT count(*) > 0, max(s.opened_owner_slot) INTO v_open, v_inherited\n    FROM document_review_signoffs s\n   WHERE s.document_version_id = NEW.document_version_id;\n  IF v_open THEN\n    NEW.opened_owner_slot := v_inherited;\n    RETURN NEW;\n  END IF;");
    expect(S.indexOf("NEW.opened_owner_slot := v_inherited;")).toBeLessThan(S.indexOf("FROM document_versions v WHERE v.id = NEW.document_version_id;"));
    expect(S.indexOf("IF TG_OP = 'UPDATE' THEN")).toBeLessThan(S.indexOf("NEW.opened_owner_slot := v_inherited;"));
    // the version's recorded author, kept raw (P17 review fix: never COALESCEd into an author)
    expect(S).toContain("  SELECT v.record_id, v.created_by INTO v_doc_id, v_created_by\n    FROM document_versions v WHERE v.id = NEW.document_version_id;");
    expect(S).not.toMatch(/COALESCE\(v\.created_by/);
    expect(S).toContain("    FROM documents d WHERE d.id = COALESCE(v_doc_id, NEW.document_id);");
    expect(S).toContain("     OR NOT review_control_owner_must_approve_for(v_control, v_collection, v_library) THEN\n    NEW.opened_owner_slot := 'none';");
    expect(S).toContain("     AND user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)");
    expect(S).toContain("  IF v_owner IS NULL THEN\n    NEW.opened_owner_slot := 'no_owner';");
    expect(S).toContain("  SELECT NOT COALESCE(l.review_control->'requireIndependentReviewer' = 'false'::jsonb, false)");
    // the author exception: only the owner OPENING the roster, on a version naming no other author
    // (created_by is writable by a library publisher through PostgREST — it never makes the owner the
    // author of a roster someone else opens)
    expect(S).toContain("  IF COALESCE(v_independent, true)\n     AND v_owner = auth.uid()\n     AND (v_created_by IS NULL OR v_created_by = auth.uid()) THEN\n    NEW.opened_owner_slot := 'author';");
    expect(S.match(/v_created_by/g)).toHaveLength(4); // declared, read, and the two tests of the author rule
    expect(S).toContain("  NEW.opened_owner_slot := 'owner:' || v_owner::text;");
    // every assignment of the stamp is one of the five outcomes
    expect([...S.matchAll(/NEW\.opened_owner_slot := ([^;]+);/g)].map((m) => m[1])).toEqual([
      "OLD.opened_owner_slot", "v_inherited", "'none'", "'no_owner'", "'author'", "'owner:' || v_owner::text",
    ]);
    expect(M).toContain("REVOKE ALL ON FUNCTION review_signoff_owner_stamp() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).toContain("CREATE TRIGGER trg_review_signoff_owner_stamp\n  BEFORE INSERT OR UPDATE ON document_review_signoffs\n  FOR EACH ROW EXECUTE FUNCTION review_signoff_owner_stamp();");
    expect(M).toContain("ALTER TABLE document_review_signoffs ADD COLUMN IF NOT EXISTS opened_owner_slot TEXT;");
  });

  it("the stamp mirrors the app's roster composition (GAP-4): the owner's slot key, the author skip under independent review, and the effective-owner chain", () => {
    const rc = src("lib/reviewControl.ts");
    // slotGroupKey.owner is the stamp's 'owner:' || uid
    expect(rc).toContain("owner: (uid: string) => `owner:${uid}`,");
    // placeOwnerSlot's outcomes: no_owner when none resolves; author when the owner authored it and authors are skipped
    expect(rc).toContain("export type OwnerSlotOutcome = \"rostered\" | \"author\" | \"no_owner\" | null;");
    expect(rc).toContain("if (skipAuthorUid && owner.userId === skipAuthorUid) return { primaries, alternates, outcome: \"author\", warning: null };");
    expect(rc).toContain("const placed = placeOwnerSlot({ primaries, alternates, owner, skipAuthorUid: requireIndependent ? authorUid : null });");
    // the independence flag: anything but false requires it (the stamp's = 'false'::jsonb)
    expect(rc).toContain("return rc?.requireIndependentReviewer !== false;");
    // the app's author is the draft's created_by, else the actor opening the roster; the stamp grants the
    // author exception only where both agree on the opener (created_by NULL or the opener) — which every
    // app opener is: submitForReview inserts the draft with created_by = the actor it then opens the
    // roster as, and the intake approve opens an external submission's (the intake route inserts no
    // created_by)
    expect(rc).toContain("let authorUid: string | null = input.actorId ?? null;");
    expect(rc).toContain("const { data: verRow } = await supabase.from(\"document_versions\").select(\"created_by\").eq(\"id\", input.versionId).maybeSingle();");
    expect(rc).toContain("if (verRow?.created_by) authorUid = String(verRow.created_by);");
    // both openers pass the signed-in user as the actor (the trigger's auth.uid())
    expect(src("lib/revisions.ts")).toContain("revisionLabel: draftLabel, contentHash: fileHash, control, actorId: actorUserId, actorName: actorEmail,");
    expect(src("lib/revisions.ts")).toContain("change_log: changeLog.trim(), created_by: actorUserId, created_by_name: actorEmail || actorUserId, created_at: now,");
    // projects-joint J16 (GAP-401): the row is built once and written either
    // through the door's identity (intake_door_submit_version, 20261184) or,
    // before that paste, as the service role — neither carries a created_by.
    const intakeInsert = between(src("app/api/intake/upload/route.ts"), "const versionRow = {", "};");
    expect(intakeInsert).toContain("intake_link_id: linkId,");
    expect(intakeInsert).not.toMatch(/\bcreated_by:/);
    expect(src("app/api/intake/upload/route.ts")).toContain(".insert(versionRow)");
    const doorInsert = between(src("supabase/migrations/20261184_prj_roundG_intake_door_identity.sql"), "INSERT INTO document_versions (", "RETURNING id INTO v_id;");
    expect(doorInsert).toContain("intake_link_id");
    expect(doorInsert).not.toMatch(/\bcreated_by\b,/);
    // the only roster writes in the app are openReviewRoster's (no other door opens a roster)
    const rosterWriters = ["lib", "app", "components"].flatMap((d) => walk(d)).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .filter((f) => /from\("document_review_signoffs"\)\s*\.(insert|upsert)\(/.test(readFileSync(f, "utf8")));
    expect(rosterWriters).toEqual(["lib/reviewControl.ts"]);
    expect(src("components/projects/IntakePanel.tsx")).toContain("control, actorId: uid, actorName: userEmail ?? null,");
    // an open roster is never changed by the app: openReviewRoster upserts with ignoreDuplicates (a re-open adds rows, never rewrites one)
    expect(rc).toContain("const upsertOpts = { onConflict: \"document_version_id,reviewer_user_id\", ignoreDuplicates: true } as const;");
    // the owner chain the app resolves through (document → folder → library → team supervisor, active members)
    expect(rc).toContain("const eff = resolveEffectiveOwner(docOwner, folderOwner, libOwner, active, teams);");
    const sqlChain = files.filter((f) => /CREATE OR REPLACE FUNCTION user_is_effective_owner\(/.test(stripComments(mig(f))));
    const owner = between(mig(sqlChain[sqlChain.length - 1]), "CREATE OR REPLACE FUNCTION user_is_effective_owner(", "\n$$;");
    expect(owner).toContain("member_is_active(v_org, p_doc_owner)");
    expect(owner).toContain("IF v_team IS NOT NULL THEN");
    // the stamp asks it about each candidate the chain can name
    expect(S).toContain("(SELECT col.owner_user_id FROM collections col WHERE col.id = v_collection)");
    expect(S).toContain("(SELECT l.owner_user_id FROM libraries l WHERE l.id = v_library)");
    expect(S).toContain("(SELECT t.supervisor_user_id FROM libraries l JOIN teams t ON t.id = l.owner_team_id");
  });
});

describe("20261159 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'\n                  AND prosrc LIKE '%v_unforced_issue := COALESCE(v_issuing%')");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote' AND pronargs = 7) THEN");
    expect(M).toContain("RAISE EXCEPTION '20261159 needs 20261151 (the REV-20 publish guard and the review promote''s recorded force) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_159_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_159_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(7);
    expect(inventory).not.toMatch(/SELECT \*|d\.id\s*,|document_number|reviewer_user_id\s*,/);
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_159_before;");
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast", () => {
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      review_signoff_owner_stamp: between(M, "CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()", "\n$$;"),
    };
    let n = 0;
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      for (const sub of seg.split(/\(SELECT (?=prosrc|pronargs|COUNT)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const re = new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(re.test(body.slice(body.indexOf("$$") + 2)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(25);
  });

  it("the header states the paste order: after 20261151 (required) and 20261070; never re-paste an earlier guard migration after it; P16 re-creates from this body", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/HOW TO APPLY: after 20261151 \(required/);
    expect(head).toMatch(/after 20261144 and 20261130 too\) and after 20261070/);
    expect(head).toMatch(/Never re-paste\n-- 20261151, 20261144, 20261139, 20261105 or any earlier guard migration after/);
    expect(head).toMatch(/Independent of 20261131, 20261143, 20261149, 20261150\n-- and 20261152/);
    expect(head).toMatch(/P18 \(REV-22's reversal restore\) re-creates this guard next,\n-- from this body, then P16 \(REV-21\) from P18's\./);
    expect(head).toMatch(/NOT a widening/);
    // P17 review fix: the intake approve has no force yet — the paste waits for INTK-18's (projects-joint J14), or the user's ratification
    expect(head).toMatch(/⚠ PASTE PRECONDITION \(REV-22, P17 review fix\): paste this only once the app\n-- deployed offers the intake approve's recorded force/);
    expect(head).toMatch(/OR once\n-- the user has ratified the interim loss \(DEC-63's P17 Landed line, awaiting\n-- ratification\)/);
    expect(head).not.toMatch(/no app change is needed for the paste/);
  });
});
