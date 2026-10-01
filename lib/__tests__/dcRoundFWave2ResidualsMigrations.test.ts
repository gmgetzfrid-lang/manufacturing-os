// document-control Round F wave 2 — P12 WAVE-2 RESIDUALS: the shape of
// migrations 20261139 (REV-17: enforce_document_publish_guard re-created from
// its NEWEST body, 20261105, plus the first-issue block; DRLS-9:
// revision_branches_org_update re-created from 20261061 with a WITH CHECK)
// and 20261140 (SHR-14: the SQL twin of lib/downloadDeny.ts and the share
// INSERT rail re-created from 20261080 with the download-deny arm).
//
// There is no live database here. Byte fidelity to the newest definitions is
// proven by lineDiff; the probes' LIKE patterns are checked against the
// bodies they will read; the SQL status list and the SQL download-deny rule
// are pinned to the TypeScript rules they mirror. Both scripts were also run
// on a throwaway PostgreSQL 16 (recorded in REV-17 / DRLS-9 / SHR-14).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { WORK_IN_PROGRESS_STATUSES, isControlledIssueStatus } from "@/lib/revisions";
import { downloadDeniedTo } from "@/lib/downloadDeny";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const M139 = mig("20261139_dc_roundF_first_issue_and_branch_closeout.sql");
const M140 = mig("20261140_dc_roundF_share_download_deny_rail.sql");
const M105 = mig("20261105_prj_roundG_intake_review_and_attempts.sql");
const M061 = mig("20261061_rp_roundE_branch_resolution_authority.sql");
const M080 = mig("20261080_dc_roundF_share_minting_and_revocation.sql");

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
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
const prosrcOf = (sql: string, fnHead: string) => {
  const fn = between(sql, fnHead, "\n$$;");
  return fn.slice(fn.indexOf("AS $$") + "AS $$".length, fn.length - "$$;".length);
};
/** Every `prosrc LIKE '…'` probe after COMMIT, checked against the body of the function it reads. */
function checkProsrcProbes(sql: string, bodies: Record<string, string>) {
  const tail = sql.slice(sql.lastIndexOf("\nCOMMIT;"));
  let checked = 0;
  for (const seg of tail.split(/\nUNION ALL\n/)) {
    const pn = seg.match(/FROM pg_proc WHERE proname = '(\w+)'/);
    if (!pn) continue;
    const body = bodies[pn[1]];
    expect(body, `no body for ${pn[1]}`).toBeDefined();
    for (const m of seg.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)) {
      for (const f of m[1].replace(/''/g, "'").split("%").filter(Boolean)) {
        expect(body.includes(f), `probe fragment not in ${pn[1]}: ${f}`).toBe(true);
      }
      checked++;
    }
  }
  return checked;
}
function pasteProtocol(name: string, text: string, tempTable: string) {
  describe(`${name} — one script, inventory first, one final result set`, () => {
    it("the inventory TEMP TABLE is captured BEFORE the one transaction; exactly one statement follows COMMIT", () => {
      const temp = text.indexOf(`CREATE TEMP TABLE ${tempTable}`);
      const begin = text.indexOf("\nBEGIN;");
      const commit = text.lastIndexOf("\nCOMMIT;");
      expect(text.indexOf(`DROP TABLE IF EXISTS ${tempTable};`)).toBeLessThan(temp);
      expect(temp).toBeGreaterThan(0);
      expect(temp).toBeLessThan(begin);
      expect(commit).toBeGreaterThan(begin);
      expect(text.match(/\nBEGIN;/g)).toHaveLength(1);
      expect(text.match(/\nCOMMIT;/g)).toHaveLength(1);
      const tail = stripComments(text.slice(commit + "\nCOMMIT;".length)).replace(/'(?:[^']|'')*'/g, "''");
      expect((tail.match(/;/g) ?? []).length).toBe(1);
      expect(tail.trim().startsWith("SELECT")).toBe(true);
    });
    it("the final SELECT has the fixed (check text, ok boolean, n text) shape; inventory rows are aggregate counts only", () => {
      const tail = text.slice(text.lastIndexOf("\nCOMMIT;"));
      expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
      expect(tail).toMatch(new RegExp(`SELECT inventory, NULL, n FROM ${tempTable};\\s*$`));
      const inv = between(text, `CREATE TEMP TABLE ${tempTable}`, "\nBEGIN;");
      const selects = (inv.match(/^SELECT /gm) ?? []).length;
      expect(selects).toBeGreaterThan(0);
      expect((inv.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(selects);
    });
    it("no LIKE pattern over a deparsed policy carries a bare cast", () => {
      const tail = text.slice(text.lastIndexOf("\nCOMMIT;"));
      for (const m of tail.matchAll(/(?:qual|with_check) (?:NOT )?LIKE '((?:[^']|'')*)'/g)) expect(m[1], m[1]).not.toMatch(/::/);
    });
  });
}

pasteProtocol("20261139", M139, "dc_round_f_139_before");
pasteProtocol("20261140", M140, "dc_round_f_140_before");

// ── REV-17 ───────────────────────────────────────────────────────────────────
describe("20261139 — REV-17: enforce_document_publish_guard = 20261105's body + the first-issue block", () => {
  const live = between(M105, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;");
  const next = between(M139, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;");

  it("20261105 is the newest definition before this one (nothing between re-created the guard)", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
    expect(defining.slice(-2)).toEqual(["20261105_prj_roundG_intake_review_and_attempts.sql", "20261139_dc_roundF_first_issue_and_branch_closeout.sql"]);
  });

  it("is byte-faithful to 20261105: nothing removed, and the only added code is the REV-17 block", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL",
      "         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')",
      "         AND NOT is_org_controller(NEW.org_id)",
      "         AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
      "              OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN",
      "          'This library requires reviewer sign-off, so a new document can''t be issued unreviewed; create it as a Draft and submit it for review, or ask Document Control.'",
    ]);
    // ordered and byte-exact: cutting the one contiguous block out of the new body gives 20261105's body
    const start = next.indexOf("      -- REV-17 (document-control Round F wave 2, P12)");
    const end = next.indexOf("      -- SEC-13 (projects Round G)");
    const blockText = next.slice(start, end);
    expect(blockText.trimEnd().endsWith("USING ERRCODE = 'check_violation';\n      END IF;")).toBe(true);
    expect(next.slice(0, start) + next.slice(end)).toBe(live);
  });

  it("the block sits in the zero-roster branch, after RG-7's Major rule and before SEC-13 (a reviewed first revision and an intake submission are not its concern)", () => {
    const zeroRoster = next.indexOf("IF COALESCE(v_primary_reqs, 0) = 0 THEN");
    const major = next.indexOf("requires reviewer sign-off for a Major revision");
    const block = next.indexOf("IF OLD.current_version_id IS NULL AND v_intake_link IS NULL");
    const sec13 = next.indexOf("-- SEC-13 (projects Round G)");
    const independence = next.indexOf("-- DEC-21: reviewer independence");
    expect(zeroRoster).toBeGreaterThan(0);
    expect(major).toBeGreaterThan(zeroRoster);
    expect(block).toBeGreaterThan(major);
    expect(sec13).toBeGreaterThan(block);
    expect(independence).toBeGreaterThan(sec13);
    // v_intake_link is read from the version before the block uses it
    expect(next.indexOf("SELECT v.review_state, v.change_type, v.intake_link_id")).toBeLessThan(block);
  });

  it("the SQL status list is exactly the app's: work in progress + NOT_CURRENT_STATUSES (isControlledIssueStatus)", () => {
    const lists = [...M139.matchAll(/COALESCE\((?:NEW|d)\.status, ''\) NOT IN \(([^)]*)\)/g)].map((m) => m[1]);
    expect(lists.length).toBe(3); // the guard + the two inventory rows
    const app = [...WORK_IN_PROGRESS_STATUSES, ...NOT_CURRENT_STATUSES].sort();
    for (const l of lists) {
      const sql = l.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
      expect(sql).toEqual(app);
      for (const s of sql) expect(isControlledIssueStatus(s)).toBe(false);
    }
  });

  it("SECURITY DEFINER with search_path pinned; no client role keeps EXECUTE (DRLS-16), and the trigger binding is untouched", () => {
    expect(next).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(M139).toMatch(/REVOKE ALL ON FUNCTION enforce_document_publish_guard\(\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(stripComments(M139)).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/);
  });

  it("every prosrc probe can match the body it reads", () => {
    const n = checkProsrcProbes(M139, { enforce_document_publish_guard: prosrcOf(M139, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()") });
    expect(n).toBeGreaterThanOrEqual(11);
  });
});

// ── DRLS-9 ───────────────────────────────────────────────────────────────────
describe("20261139 — DRLS-9: revision_branches_org_update = 20261061's USING + a WITH CHECK", () => {
  const live = between(M061, "CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (", "\n);\n");
  const next = between(M139, "CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (", "\n);\n");
  const usingLive = between(live, "FOR UPDATE USING (\n", "\n  )\n");
  const [usingNext, check] = next.split(") WITH CHECK (\n");

  it("20261061 is the newest definition before this one", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const defining = files.filter((f) => /CREATE POLICY revision_branches_org_update ON/.test(stripComments(mig(f))));
    expect(defining.slice(-2)).toEqual(["20261061_rp_roundE_branch_resolution_authority.sql", "20261139_dc_roundF_first_issue_and_branch_closeout.sql"]);
  });

  it("the USING is 20261061's byte for byte (who may resolve is DEC-11's: a controller or the effective owner), and the WITH CHECK opens with the same authority", () => {
    // 20261061's policy up to (not including) its closing ");" is the new policy's head, byte for byte
    const head = live.slice(0, live.length - ");\n".length);
    expect(next.startsWith(head + ") WITH CHECK (\n")).toBe(true);
    expect(usingNext + ") WITH CHECK (\n").toBe(head + ") WITH CHECK (\n");
    const authority = head.slice(head.indexOf("\n") + 1); // the USING's body
    expect(check.startsWith(authority)).toBe(true);
    expect(usingLive.length).toBeGreaterThan(0);
  });

  it("the WITH CHECK adds exactly the resolution rules: resolved, merged | withdrawn, a non-empty note, by the caller, and a 'merged' claim tied to a later revision", () => {
    const head = live.slice(0, live.length - ");\n".length);
    const added = check.slice(head.slice(head.indexOf("\n") + 1).length);
    expect(code(added.split("\n"))).toEqual([
      "  AND resolved_at IS NOT NULL",
      "  AND resolution IN ('merged', 'withdrawn')",
      "  AND btrim(COALESCE(resolution_note, '')) <> ''",
      "  AND resolved_by = auth.uid()::text",
      "  AND (",
      "    resolution = 'withdrawn'",
      "    OR EXISTS (SELECT 1 FROM documents d",
      "                 JOIN document_versions cv ON cv.id = d.current_version_id",
      "                 JOIN document_versions bv ON bv.id = revision_branches.branch_version_id",
      "                WHERE d.id = revision_branches.document_id",
      "                  AND cv.id <> bv.id",
      "                  AND cv.created_at > bv.created_at)",
      "  )",
      ");",
    ]);
    expect(lineDiff(live, next).onlyInA).toEqual([]);
  });

  it("the app's resolve writes exactly what the WITH CHECK requires (resolved_at, the caller as resolved_by, a resolution, a trimmed non-empty note)", () => {
    const b = readFileSync(join(process.cwd(), "lib/branches.ts"), "utf8");
    expect(b).toMatch(/if \(!input\.note\.trim\(\)\) throw new Error\("A resolution note is required"\);/);
    expect(b).toMatch(/resolved_at: now,\s*\n\s*resolved_by: input\.actorUserId,\s*\n\s*resolved_by_name: input\.actorName,\s*\n\s*resolution: input\.resolution,\s*\n\s*resolution_note: input\.note\.trim\(\),/);
    expect(readFileSync(join(process.cwd(), "components/documents/DocControlQueue.tsx"), "utf8")).toMatch(/actorUserId: currentUser\.uid,/);
  });

  it("a merge claim the rail refuses is reported as a refusal by resolveBranch, not as success", () => {
    const b = readFileSync(join(process.cwd(), "lib/branches.ts"), "utf8");
    expect(b).toMatch(/if \(error\) throw new Error\(error\.message\);/);
    expect(b).toMatch(/if \(!data\) throw new Error\("Branch was not resolved/);
  });
});

// ── SHR-14 ───────────────────────────────────────────────────────────────────
describe("20261140 — SHR-14: user_download_denied mirrors lib/downloadDeny.ts", () => {
  const fn = between(M140, "CREATE OR REPLACE FUNCTION user_download_denied(", "\n$$;");

  it("STABLE SECURITY DEFINER, search_path pinned; anon and PUBLIC revoked, authenticated granted (the INSERT policy runs as the caller)", () => {
    expect(fn).toMatch(/RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(M140).toMatch(/REVOKE ALL ON FUNCTION user_download_denied\(jsonb, uuid, uuid\) FROM PUBLIC, anon;/);
    expect(M140).toMatch(/GRANT EXECUTE ON FUNCTION user_download_denied\(jsonb, uuid, uuid\) TO authenticated, service_role;/);
  });

  it("is no oracle: a signed-in caller may ask about themself only", () => {
    expect(fn).toMatch(/IF auth\.uid\(\) IS NOT NULL AND p_uid IS DISTINCT FROM auth\.uid\(\) THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it("reads the same three buckets the TypeScript rule reads, every role in the ACTIVE collection, an empty collection as Viewer, controllers not exempt", () => {
    expect(fn).toMatch(/\(v_deny -> 'users' -> 'download'\) \? p_uid::text/);
    expect(fn).toMatch(/WHERE m\.org_id = p_org AND m\.uid = p_uid AND m\.status = 'active'/);
    expect(fn).toMatch(/unnest\(COALESCE\(v_roles, ARRAY\[\]::text\[\]\) \|\| v_role\)/);
    expect(fn).toMatch(/IF cardinality\(v_roles\) = 0 THEN\s*\n\s*v_roles := ARRAY\['Viewer'\];/);
    expect(fn).toMatch(/EXISTS \(SELECT 1 FROM unnest\(v_roles\) AS r WHERE \(v_deny -> 'roles' -> 'download'\) \? r\)/);
    expect(fn).toMatch(/FROM team_members t\s*\n\s*WHERE t\.uid = p_uid AND \(v_deny -> 'teams' -> 'download'\) \? t\.team_id::text/);
    expect(fn).not.toMatch(/is_org_controller|Admin|DocCtrl/);
    // the TypeScript side: the same buckets, the Viewer default, no controller exemption
    const ts = readFileSync(join(process.cwd(), "lib/downloadDeny.ts"), "utf8");
    expect(ts).toMatch(/if \(roles\.length === 0\) roles\.push\("Viewer"\);/);
    expect(ts).toMatch(/\.eq\("status", "active"\)/);
    expect(ts).toMatch(/sb\.from\("team_members"\)\.select\("team_id"\)\.eq\("uid", input\.uid\)/);
  });

  it("the two rules agree on a table of cases (the SQL transcribed as a pure function over the same inputs)", () => {
    // A transcription of the plpgsql above, pinned to it by the regexes in the case before.
    const sqlRule = (idx: unknown, uid: string, member: { role: string | null; roles: string[] | null } | null, teams: string[]): boolean => {
      const deny = (idx as { deny?: unknown } | null)?.deny as Record<string, Record<string, unknown>> | undefined;
      if (!deny || typeof deny !== "object" || Array.isArray(deny)) return false;
      const arr = (b: string) => (Array.isArray(deny[b]?.download) ? (deny[b].download as string[]) : null);
      if (arr("users")?.includes(uid)) return true;
      let roles = [...new Set([...(member?.roles ?? []), member?.role].filter((r): r is string => !!r && r.trim() !== ""))];
      if (roles.length === 0) roles = ["Viewer"];
      if (arr("roles") && roles.some((r) => arr("roles")!.includes(r))) return true;
      if (arr("teams") && teams.some((t) => arr("teams")!.includes(t))) return true;
      return false;
    };
    const tsRule = (idx: unknown, uid: string, member: { role: string | null; roles: string[] | null } | null, teams: string[]) => {
      const roles = [...new Set([...(member?.roles ?? []), ...(member?.role ? [member.role] : [])])];
      if (roles.length === 0) roles.push("Viewer");
      return downloadDeniedTo(idx as never, { uid, roles, teamIds: teams });
    };
    const U = "u-1";
    const cases: Array<[unknown, { role: string | null; roles: string[] | null } | null, string[]]> = [
      [null, { role: "Engineer-1", roles: ["Engineer-1"] }, []],
      [{ deny: { users: { download: [U] } } }, { role: "Viewer", roles: null }, []],
      [{ deny: { users: { download: ["someone-else"] } } }, { role: "Viewer", roles: null }, []],
      [{ deny: { roles: { download: ["Engineer-1"] } } }, { role: "Manager", roles: ["Manager", "Engineer-1"] }, []], // additive role binds (CHAIN-1)
      [{ deny: { roles: { download: ["DocCtrl"] } } }, { role: "DocCtrl", roles: ["DocCtrl"] }, []], // controllers not exempt
      [{ deny: { roles: { download: ["Viewer"] } } }, null, []], // no active membership reads as Viewer
      [{ deny: { roles: { download: ["Viewer"] } } }, { role: null, roles: [] }, []], // an empty collection reads as Viewer
      [{ deny: { roles: { download: ["Viewer"] } } }, { role: "Drafter", roles: ["Drafter"] }, []],
      [{ deny: { teams: { download: ["t1"] } } }, { role: "Drafter", roles: null }, ["t2", "t1"]],
      [{ deny: { teams: { download: ["t1"] } } }, { role: "Drafter", roles: null }, ["t2"]],
      [{ deny: { users: { view: [U] } } }, { role: "Drafter", roles: null }, []], // another action's deny
    ];
    for (const [idx, member, teams] of cases) {
      expect(sqlRule(idx, U, member, teams), JSON.stringify([idx, member, teams])).toBe(tsRule(idx, U, member, teams));
    }
  });
});

describe("20261140 — SHR-14: document_shares_insert = 20261080's body + the download-deny arm", () => {
  const live = between(M080, "CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (", "\n);\n");
  const next = between(M140, "CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (", "\n);\n");

  it("20261080 is the newest definition before this one", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const defining = files.filter((f) => /CREATE POLICY document_shares_insert ON/.test(stripComments(mig(f))));
    expect(defining.slice(-2)).toEqual(["20261080_dc_roundF_share_minting_and_revocation.sql", "20261140_dc_roundF_share_download_deny_rail.sql"]);
  });

  it("is byte-faithful to 20261080: nothing removed, and the only added code is the download-deny arm", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "  AND NOT EXISTS (",
      "      AND user_download_denied(d.acl_index, auth.uid(), document_shares.org_id)",
    ]);
    // ordered and byte-exact: cutting the one contiguous arm out gives 20261080's policy
    const start = next.indexOf("  -- SHR-14 (P12)");
    const end = next.lastIndexOf("\n);\n");
    expect(start).toBeGreaterThan(0);
    expect(next.slice(0, start) + next.slice(end + 1)).toBe(live);
    // the arm reads the row's own document (the same documents d join the policy uses)
    expect(next).toMatch(/AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM documents d\s*\n\s*WHERE d\.id = document_shares\.document_id\s*\n\s*AND user_download_denied/);
  });

  it("the only other objects it touches are the new function — not the anchor guard, the refusal function or another policy", () => {
    const body = stripComments(between(M140, "\nBEGIN;", "\nCOMMIT;"));
    expect(body.match(/CREATE (?:OR REPLACE )?(?:FUNCTION|POLICY|TRIGGER) (\w+)/g)).toEqual([
      "CREATE OR REPLACE FUNCTION user_download_denied",
      "CREATE POLICY document_shares_insert",
    ]);
  });

  it("every prosrc probe can match the body it reads", () => {
    const n = checkProsrcProbes(M140, { user_download_denied: prosrcOf(M140, "CREATE OR REPLACE FUNCTION user_download_denied(") });
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it("lib/downloadDeny.ts no longer says there is no SQL twin", () => {
    const ts = readFileSync(join(process.cwd(), "lib/downloadDeny.ts"), "utf8");
    expect(ts).not.toMatch(/There is no SQL twin\./);
    expect(ts).toMatch(/The SQL twin is user_download_denied \(20261140, public-surfaces SHR-14\)/);
  });
});
