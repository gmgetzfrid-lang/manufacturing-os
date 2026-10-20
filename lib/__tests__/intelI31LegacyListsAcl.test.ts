// intelligence Round G, I-31 LEGACY LISTS INTO THE ACL — the default-suite
// pins (the PostgreSQL 16 equivalence run is lib/__tests__/rls/
// intelI31LegacyListsAcl.test.ts, `npm run test:db`).
//
//   1. 20261228's shape (DEC-30): a counts-only inventory before the
//      transaction, BEGIN / COMMIT, one final SELECT (check, ok, n); it
//      creates no function, policy or trigger, adds no RESTRICTIVE policy,
//      never names node_visible outside its probes, and writes only libraries
//      (and one audit row each).
//   2. Its SQL rung is lib/libraryAccess legacyLibraryAcl's: the same action
//      list, the same four lists in the same order, the same "ALL" / NULL
//      rule, the same "the ACL says nothing" rule, the same no-role
//      visibility, and lib/acl's index shape (every action key, every
//      subject bucket, no deny).
//   3. The app before and after the paste (pure TypeScript, every reader
//      that decides on a library's ACL): writing the rung into acl /
//      acl_index changes no answer for anyone — the library page, the card,
//      the content read predicate, publish, the drawer's authority — and,
//      since the I-31 merge (DACL-13 R1, ruled by the integrator under
//      DEC-90), the ticket triage picker, its server check and its label,
//      which now read the effective ACL (lib/ticketLibrary).
//   1b. The paste order the header states: the I-31 deploy (the triage
//      readers on the rung, the controller-first canPublish) is a hard
//      prerequisite of the paste; no ruling gate remains (DACL-13 R1 built,
//      R2 accepted), and the private / hidden listing that follows the paste
//      is said precisely (DACL-13 R2).
//   4. ALOG-13: the wizard's upload picker seed (wizardUploadRolesSeed); a
//      NEW library's writers name no write_access / admin_access, and a
//      wizard EDIT keeps them in step with its ACL (wizardListColumnsFromAcl)
//      so a later drawer clear never falls back to stale roles.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveLibraryAclFromRow, explorerLibraryVisible, legacyLibraryAcl, libraryConfigFromRow,
  libraryReadsByRole, wizardListColumnsFromAcl, wizardUploadRolesSeed,
} from "@/lib/libraryAccess";
import { aclSaysSomething, buildAclIndexFromChain } from "@/lib/acl";
import { canPublishOnLibrary, canPublishViaIndex, canReadNode, canWithAclChain, isControllerPrincipal, type Principal } from "@/lib/permissions";
import { LIBRARY_CHOICE_COLUMNS, libraryChoiceFromRow, libraryLabelForTicket, offerableLibraries } from "@/lib/ticketLibrary";
import { mergeWizardLibraryAcl } from "@/lib/acl";
import type { AccessControl, AccessRule, LibraryConfig, Role } from "@/types/schema";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const FILE = "supabase/migrations/20261228_intel_roundG_legacy_lists_into_acl.sql";
const SQL = src(FILE);
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");
const CODE = stripComments(SQL);

describe("20261228 — DEC-30 shape", () => {
  it("header, a counts-only inventory BEFORE the transaction, one BEGIN / COMMIT, then one final SELECT (check, ok, n)", () => {
    expect(SQL.startsWith("-- ─")).toBe(true);
    expect(SQL).toMatch(/PASTE FACTS\./);
    expect(SQL).toMatch(/ROLLBACK/);
    const begin = CODE.indexOf("\nBEGIN;");
    const commit = CODE.indexOf("\nCOMMIT;");
    expect(CODE.split("\nBEGIN;")).toHaveLength(2);
    expect(CODE.split("\nCOMMIT;")).toHaveLength(2);
    const view = CODE.indexOf("CREATE OR REPLACE TEMP VIEW intel_i31_20261228_rung");
    const inv = CODE.indexOf("CREATE TEMP TABLE intel_i31_20261228_inventory");
    expect(view).toBeGreaterThan(0);
    expect(inv).toBeGreaterThan(view);
    expect(begin).toBeGreaterThan(inv);
    expect(commit).toBeGreaterThan(begin);
    const tail = CODE.slice(commit + "\nCOMMIT;".length);
    // exactly one statement after COMMIT, the result set
    expect(tail.match(/;\s*$/gm) ?? []).toHaveLength(1);
    expect(tail).toMatch(/^\s*SELECT '(?:[^']|'')+' AS check,/m);
    expect(tail).toMatch(/AS ok, NULL::text AS n/);
    // the inventory rows shown carry ok NULL and n the count as text; the
    // fingerprints (h) are never shown
    expect(tail.trim().endsWith("SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i31_20261228_inventory WHERE h IS NULL ORDER BY ord) i;")).toBe(true);
  });

  it("the inventory inserted before BEGIN is aggregates only (COUNT / SUM, md5 fingerprints) — never a customer row", () => {
    const before = CODE.slice(CODE.indexOf("CREATE TEMP TABLE intel_i31_20261228_inventory"), CODE.indexOf("\nBEGIN;"));
    const selects = before.split(/\nUNION ALL\n/);
    for (const part of selects) {
      if (!/^\s*SELECT \d+,/.test(part) && !/INSERT INTO intel_i31_20261228_inventory/.test(part)) continue;
      expect(part, part.slice(0, 120)).toMatch(/COUNT\(|SUM\(|md5\(/);
    }
    expect(before).not.toMatch(/SELECT\s+\*/);
  });

  it("creates no function, policy or trigger; adds no RESTRICTIVE policy; leaves node_visible alone; writes libraries (and audit rows) only", () => {
    expect(CODE).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(CODE).not.toMatch(/CREATE\s+POLICY/i);
    expect(CODE).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i);
    expect(CODE).not.toMatch(/AS\s+RESTRICTIVE/i);
    expect(CODE).not.toMatch(/ALTER\s+TABLE/i);
    expect(CODE).not.toMatch(/\bDROP\s+(POLICY|FUNCTION|TRIGGER|COLUMN)/i);
    // node_visible / acl_index_denies appear only in the fingerprint and its probe
    expect(CODE).not.toMatch(/FUNCTION\s+(public\.)?node_visible/i);
    const lines = CODE.split("\n").filter((l) => /node_visible/.test(l));
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l, l).toMatch(/proname IN \('node_visible', 'acl_index_denies'\)|'fingerprint: node_visible \/ acl_index_denies bodies'|^SELECT 'node_visible and acl_index_denies are untouched/);
    }
    const updates = [...CODE.matchAll(/\bUPDATE\s+(\w+)/g)].map((m) => m[1]);
    expect(updates).toEqual(["libraries"]);
    const inserts = [...CODE.matchAll(/\bINSERT\s+INTO\s+(\w+)/g)].map((m) => m[1]);
    expect([...new Set(inserts)].sort()).toEqual(["audit_logs", "intel_i31_20261228_inventory"]);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM/i);
    // the write re-checks the row it locks (ACL still says nothing, list still
    // restricts, lists and visibility as computed) — a concurrent edit is never overwritten
    const upd = CODE.slice(CODE.indexOf("UPDATE libraries l"), CODE.indexOf("RETURNING l.id"));
    for (const c of ["read_access", "visible_to", "write_access", "admin_access", "visibility"]) {
      expect(upd).toContain(`l.${c} IS NOT DISTINCT FROM r.${c}`);
    }
    expect(upd).toMatch(/AND r\.to_write/);
    expect(upd).toMatch(/SET acl = r\.rung_acl, acl_index = r\.rung_index/);
  });
});

describe("20261228 — its SQL rung is lib/libraryAccess legacyLibraryAcl's", () => {
  const view = CODE.slice(CODE.indexOf("CREATE OR REPLACE TEMP VIEW"), CODE.indexOf("DROP TABLE IF EXISTS pg_temp.intel_i31_20261228_inventory"));

  it("the same actions, in the same order", () => {
    const rung = legacyLibraryAcl({ readAccess: ["HR" as Role] })!;
    expect(view).toContain(`'${JSON.stringify(rung.rules[0].actions).replace(/,/g, ", ")}'::jsonb`);
    expect(rung.rules[0].actions).toEqual(["discover", "read", "download"]);
    expect(rung.inherit).toBe(true);
  });

  it("the four lists in the app's order; a list that is not an array names no role", () => {
    expect(view).toMatch(/VALUES \(1, lib\.read_access\), \(2, lib\.visible_to\),\s+\(3, lib\.write_access\), \(4, lib\.admin_access\)/);
    expect(view).toContain("CASE WHEN jsonb_typeof(s.list) = 'array' THEN s.list ELSE '[]'::jsonb END");
    const r = legacyLibraryAcl({ readAccess: ["A" as Role], visibleTo: ["B" as Role, "A" as Role], writeAccess: ["C" as Role], adminAccess: ["B" as Role, "D" as Role] })!;
    expect(r.rules.map((x) => x.subject.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("restricted = neither \"ALL\" nor NULL (JSON null too); the ACL says nothing = lib/acl aclSaysSomething false", () => {
    expect(view).toContain(`(l.read_access IS NOT NULL AND l.read_access <> 'null'::jsonb\n          AND l.read_access <> '"ALL"'::jsonb) AS restricted`);
    expect(view).toContain("(jsonb_typeof(l.acl->'rules') = 'array' AND jsonb_array_length(l.acl->'rules') > 0)");
    expect(view).toContain("OR l.acl->>'visibility' IN ('hidden', 'private')");
    expect(aclSaysSomething({ inherit: true, visibility: "normal", rules: [] } as AccessControl)).toBe(false);
    expect(aclSaysSomething({ inherit: true, visibility: "private", rules: [] } as AccessControl)).toBe(true);
    expect(effectiveLibraryAclFromRow({ read_access: "ALL", acl: null })).toBeUndefined();
    expect(effectiveLibraryAclFromRow({ read_access: null, acl: null })).toBeUndefined();
  });

  it("a list naming no role is a private rung (hidden when the library is hidden), with no grant and no index", () => {
    expect(view).toContain("THEN CASE WHEN r.visibility = 'hidden' THEN 'hidden' ELSE 'private' END");
    expect(view).toContain("ELSE COALESCE(r.visibility, 'normal') END");
    expect(legacyLibraryAcl({ readAccess: [] })).toEqual({ inherit: true, visibility: "private", rules: [] });
    expect(legacyLibraryAcl({ readAccess: [], visibility: "hidden" })).toEqual({ inherit: true, visibility: "hidden", rules: [] });
    expect(buildAclIndexFromChain([legacyLibraryAcl({ readAccess: [] })])).toBeNull();
    expect(view).toContain("CASE WHEN r.role_count = 0 THEN NULL ELSE jsonb_build_object(");
  });

  it("lib/acl's index shape: every action key in every subject bucket, the roles under discover / read / download, no deny", () => {
    const idx = buildAclIndexFromChain([legacyLibraryAcl({ readAccess: ["HR" as Role] })])!;
    const actions = Object.keys(idx.allow.roles).sort();
    expect(actions).toHaveLength(10);
    for (const bucket of ["users", "teams", "orgs"] as const) {
      const literal = `'${bucket}', '{${Object.keys(idx.allow[bucket]!).map((a) => `"${a}": []`).join(", ")}}'::jsonb`;
      expect(view, bucket).toContain(literal);
    }
    expect(view).toContain("'roles', jsonb_build_object('discover', r.role_ids, 'read', r.role_ids, 'download', r.role_ids,");
    for (const a of actions.filter((x) => !["discover", "read", "download"].includes(x))) expect(view).toContain(`'${a}', '[]'::jsonb`);
    for (const side of Object.values(idx.deny)) for (const list of Object.values(side ?? {})) expect(list).toEqual([]);
  });
});

// ── 3. the app before and after the paste ───────────────────────────────────
const ORG = "org-1";
const P = (uid: string, role: Role | null, roles: Role[] = [], teamIds: string[] = []): Principal =>
  ({ uid, role: role as Role, roles, orgId: ORG, teamIds, isActiveMember: true });
const PRINCIPALS: Record<string, Principal> = {
  admin: P("u-admin", "Admin" as Role),
  addCtrl: P("u-addctrl", "Viewer" as Role, ["DocCtrl" as Role]),
  hr: P("u-hr", "HR" as Role),
  engineer: P("u-eng", "Engineer" as Role),
  supervisor: P("u-sup", "Supervisor" as Role),
  vendor: P("u-vendor", "Vendor" as Role),
  owner: P("u-owner", "Viewer" as Role),
  multi: P("u-multi", "Viewer" as Role, ["HR" as Role]),
  teamed: P("u-team", "Vendor" as Role, [], ["team-1"]),
};
const LEGACY_ROWS: Record<string, Record<string, unknown>> = {
  nullAclOwned: { id: "L1", org_id: ORG, acl: null, acl_index: null, visibility: "normal", owner_user_id: "u-owner", read_access: ["HR"], visible_to: [], write_access: ["Engineer"], admin_access: [] },
  zeroRule: { id: "L2", org_id: ORG, acl: { inherit: true, visibility: "normal", rules: [] }, acl_index: null, visibility: "normal", owner_user_id: null, read_access: ["HR"], visible_to: ["Supervisor"], write_access: [], admin_access: [] },
  noRole: { id: "L3", org_id: ORG, acl: null, acl_index: null, visibility: "normal", owner_user_id: null, read_access: [], visible_to: [], write_access: [], admin_access: [] },
  noRoleHidden: { id: "L4", org_id: ORG, acl: null, acl_index: null, visibility: "hidden", owner_user_id: null, read_access: [], visible_to: null, write_access: null, admin_access: null },
  malformed: { id: "L5", org_id: ORG, acl: null, acl_index: null, visibility: null, owner_user_id: null, read_access: "weird", visible_to: "x", write_access: {}, admin_access: 3 },
  inheritFalseZeroRule: { id: "L6", org_id: ORG, acl: { inherit: false, visibility: "normal", rules: [] }, acl_index: null, visibility: "normal", owner_user_id: null, read_access: ["Engineer", "HR"], visible_to: [], write_access: [], admin_access: ["HR"] },
};
/** What 20261228 does to a row (the DB run proves the SQL produces exactly this). */
const pasted = (row: Record<string, unknown>) => {
  const rung = effectiveLibraryAclFromRow(row)!;
  return { ...row, acl: JSON.parse(JSON.stringify(rung)), acl_index: buildAclIndexFromChain([rung]) };
};
const TEAM_GRANT_FOLDER = { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "team", id: "team-1" }, actions: ["discover", "read"] }] } as AccessControl;
const PRIVATE_DOC = { inherit: true, visibility: "private", rules: [] } as AccessControl;

function answers(row: Record<string, unknown>, who: Principal) {
  const cfg = libraryConfigFromRow(row) as LibraryConfig & { ownerUserId?: string | null };
  const rung = effectiveLibraryAclFromRow(row);
  const owner = (row.owner_user_id as string | null) ?? null;
  return {
    // the library page ("you don't have access")
    page: explorerLibraryVisible(who, cfg),
    // the documents home card (the lists, unchanged by the paste)
    card: who.role !== null && libraryReadsByRole(cfg, who.role, who.roles ?? []),
    // the AI seam / bytes door read predicate, a normal and a private document
    normalDoc: canReadNode({ principal: who, aclChain: [rung ?? null, null], visibility: "normal", effectiveOwnerUserId: owner }),
    privateDoc: canReadNode({ principal: who, aclChain: [rung ?? null, PRIVATE_DOC], visibility: "private", effectiveOwnerUserId: owner }),
    // a deeper grant (a folder shared with a team)
    teamFolderDoc: canReadNode({ principal: who, aclChain: [rung ?? null, TEAM_GRANT_FOLDER, null], visibility: "normal", effectiveOwnerUserId: owner }),
    // write-shaped authority over the library: publish (controllers, then the
    // index, then the raw ACL — the library page's canPublish and
    // lib/documentGuards resolveCanControlLibrary) and the drawer's
    publish: isControllerPrincipal(who)
      || (canPublishViaIndex((row.acl_index ?? null) as never, who) ?? canPublishOnLibrary({ principal: who, libraryAcl: (row.acl ?? undefined) as AccessControl | undefined })),
    managePermissions: canWithAclChain({ principal: who, action: "managePermissions", aclChain: [(row.acl ?? undefined) as AccessControl | undefined], defaultAllow: false }),
  };
}

describe("I-31 — the app's answer before the paste equals its answer after, for every member and every legacy library", () => {
  for (const [name, row] of Object.entries(LEGACY_ROWS)) {
    it(`${name}: page, card, content reads (incl. private and a deeper team grant), publish and the drawer's authority are unchanged`, () => {
      const after = pasted(row);
      expect(aclSaysSomething(after.acl as AccessControl)).toBe(true);
      expect(legacyLibraryAcl({ ...libraryConfigFromRow(after) })).toBeUndefined(); // the fallback no longer applies
      for (const [who, principal] of Object.entries(PRINCIPALS)) {
        expect(answers(after, principal), `${name} / ${who}`).toEqual(answers(row, principal));
      }
    });
  }

  it("the expected people still read: listed roles (headline or additive), the upload / admin roles, controllers, the owner; a team grant deeper in the tree still admits", () => {
    const after = pasted(LEGACY_ROWS.nullAclOwned);
    const who = (k: keyof ReturnType<typeof answers>) => Object.entries(PRINCIPALS).filter(([, p]) => answers(after, p)[k]).map(([n]) => n);
    expect(who("privateDoc")).toEqual(["admin", "addCtrl", "hr", "engineer", "owner", "multi"]);
    expect(who("teamFolderDoc")).toEqual(["admin", "addCtrl", "hr", "engineer", "owner", "multi", "teamed"]);
    expect(who("card")).toEqual(["hr", "multi"]); // the card is the read lists (controllers see every card on the page itself)
    expect(who("publish")).toEqual(["admin", "addCtrl"]);
    const noRole = pasted(LEGACY_ROWS.noRole);
    expect(Object.entries(PRINCIPALS).filter(([, p]) => answers(noRole, p).page).map(([n]) => n)).toEqual(["admin", "addCtrl"]);
  });

  it("publish: a controller keeps it on the library page once the library carries the rung's index (the page asks controllers first, as the mutator and the database do)", () => {
    const after = pasted(LEGACY_ROWS.nullAclOwned);
    // the defect the paste would have exposed: an index that grants Admin nothing answers "no"
    expect(canPublishViaIndex(after.acl_index as never, PRINCIPALS.admin)).toBe(false);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    const memo = page.slice(page.indexOf("const canPublish = useMemo(() => {"), page.indexOf("}, [principal, library?.acl, library?.aclIndex]);"));
    expect(memo.indexOf("if (isControllerPrincipal(principal)) return true;")).toBeGreaterThan(0);
    expect(memo.indexOf("if (isControllerPrincipal(principal)) return true;")).toBeLessThan(memo.indexOf("canPublishViaIndex("));
    expect(src("lib/documentGuards.ts")).toMatch(/resolveCanControlLibrary\([\s\S]*?if \(isControllerPrincipal\(principal\)\) return true;[\s\S]*?canPublishViaIndex\(/);
  });

  it("the rung the paste writes carries no deny and no write-shaped grant (documents_deny_upload_guard, publish and can_manage_node answer as before)", () => {
    for (const row of Object.values(LEGACY_ROWS)) {
      const after = pasted(row);
      for (const r of (after.acl as AccessControl).rules as AccessRule[]) {
        expect(r.effect).toBe("allow");
        expect(r.actions).toEqual(["discover", "read", "download"]);
      }
      if (after.acl_index) {
        for (const side of Object.values((after.acl_index as { deny: Record<string, Record<string, unknown[]>> }).deny)) {
          for (const list of Object.values(side)) expect(list).toEqual([]);
        }
      }
    }
  });

  it("DACL-13 R1: the ticket triage picker and its server check read the EFFECTIVE ACL, so their answer is the same before and after the paste — and equals the library page's", () => {
    for (const [name, row] of Object.entries(LEGACY_ROWS)) {
      const after = pasted(row);
      for (const [who, principal] of Object.entries(PRINCIPALS)) {
        const before0 = offerableLibraries([libraryChoiceFromRow({ ...row, name: "HR records" })], principal).length;
        const after0 = offerableLibraries([libraryChoiceFromRow({ ...after, name: "HR records" })], principal).length;
        expect(after0, `${name} / ${who}: offered before = after`).toBe(before0);
        expect(before0 === 1, `${name} / ${who}: offered = the library page's answer`).toBe(answers(row, principal).page);
      }
    }
    // the case DACL-13 named: the Vendor (no role in the lists) is not offered the legacy library, before or after
    const row = LEGACY_ROWS.nullAclOwned;
    expect(offerableLibraries([libraryChoiceFromRow(row)], PRINCIPALS.vendor)).toHaveLength(0);
    expect(offerableLibraries([libraryChoiceFromRow(pasted(row))], PRINCIPALS.vendor)).toHaveLength(0);
    for (const k of ["hr", "engineer", "admin", "addCtrl", "owner", "multi"]) {
      expect(offerableLibraries([libraryChoiceFromRow(row)], PRINCIPALS[k]), k).toHaveLength(1);
      expect(offerableLibraries([libraryChoiceFromRow(pasted(row))], PRINCIPALS[k]), k).toHaveLength(1);
    }
  });

  it("DACL-13 R1: the triage history label reads the effective ACL too — a legacy library is 'the target library' before the paste as after it", () => {
    for (const [name, row] of Object.entries(LEGACY_ROWS)) {
      const before0 = libraryLabelForTicket(libraryChoiceFromRow({ ...row, name: "HR records" }));
      const after0 = libraryLabelForTicket(libraryChoiceFromRow({ ...pasted(row), name: "HR records" }));
      expect(before0, name).toBe("the target library");
      expect(after0, name).toBe(before0);
    }
  });

  it("no regression: a library the paste does not write is offered and named exactly as before (Everyone, NULL lists, an ACL that says something), and a row read without the lists is decided by its raw ACL as before", () => {
    const wizardEveryone = { inherit: true, visibility: "normal", rules: [
      { effect: "allow", subject: { type: "org", id: ORG }, actions: ["discover", "read", "download"] },
    ] } as AccessControl;
    const untouched: Record<string, Record<string, unknown>> = {
      all: { id: "U1", name: "Open", acl: null, visibility: "normal", owner_user_id: null, read_access: "ALL", visible_to: [], write_access: [], admin_access: [] },
      nullRead: { id: "U2", name: "Open", acl: null, visibility: "normal", owner_user_id: null, read_access: null, visible_to: null, write_access: null, admin_access: null },
      everyone: { id: "U3", name: "Open", acl: wizardEveryone, visibility: "normal", owner_user_id: null, read_access: "ALL", visible_to: [], write_access: ["Admin"], admin_access: ["Admin"] },
      saysSomething: { id: "U4", name: "Eng", acl: { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "role", id: "Engineer" }, actions: ["discover", "read", "download"] }] }, visibility: "normal", owner_user_id: null, read_access: ["HR"], visible_to: [], write_access: [], admin_access: [] },
      privateLib: { id: "U5", name: "Private", acl: null, visibility: "private", owner_user_id: "u-owner", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] },
    };
    // the pre-R1 reading: the raw ACL only
    const raw = (r: Record<string, unknown>) => ({ id: String(r.id), name: String(r.name), visibility: (r.visibility as string) ?? null, acl: (r.acl ?? null) as AccessControl | null, ownerUserId: (r.owner_user_id as string | null) ?? null });
    for (const [name, r] of Object.entries(untouched)) {
      for (const [who, principal] of Object.entries(PRINCIPALS)) {
        expect(offerableLibraries([libraryChoiceFromRow(r)], principal), `${name} / ${who}`).toEqual(offerableLibraries([raw(r)], principal));
      }
      expect(libraryLabelForTicket(libraryChoiceFromRow(r)), name).toBe(libraryLabelForTicket(raw(r)));
    }
    expect(libraryLabelForTicket(libraryChoiceFromRow(untouched.all))).toBe("Open");
    expect(offerableLibraries([libraryChoiceFromRow(untouched.all)], PRINCIPALS.vendor)).toHaveLength(1);
    // a caller that does not carry the lists keeps the raw reading (what the close notice's label read until DF-P15)
    expect(libraryLabelForTicket({ name: "HR records", visibility: "normal", acl: LEGACY_ROWS.nullAclOwned.acl })).toBe("HR records");
    expect(offerableLibraries([raw(LEGACY_ROWS.nullAclOwned)], PRINCIPALS.vendor)).toHaveLength(1);
  });

  it("DACL-13 R1 is wired: the picker and the workflow-action library check select the rung's columns and decide through libraryChoiceFromRow; the route's close notice's label reads the rung too since DF-P15 (the header, written at I-31, still names it as the raw read it then was)", () => {
    expect(LIBRARY_CHOICE_COLUMNS).toBe("id, name, owner_user_id, acl, visibility, read_access, visible_to, write_access, admin_access");
    const picker = src("components/requests/LibraryPicker.tsx");
    expect(picker).toContain('supabase.from("libraries").select(LIBRARY_CHOICE_COLUMNS).eq("org_id", orgId)');
    expect(picker).toContain(".map(libraryChoiceFromRow)");
    expect(picker).not.toContain('select("id, name, visibility, acl, owner_user_id")');
    const route = src("app/api/tickets/workflow-action/route.ts");
    const check = route.slice(route.indexOf("if (wantsLibrary) {"), route.indexOf("if (wantsUnit) {"));
    expect(check).toContain('supabaseAdmin.from("libraries").select(LIBRARY_CHOICE_COLUMNS)');
    expect(check).toContain("const libRow = lib ? libraryChoiceFromRow(lib as unknown as Record<string, unknown>) : null;");
    expect(check).toContain("const offered = libRow ? offerableLibraries([libRow], principal) : [];");
    expect(check).toContain("name: libraryLabelForTicket(libRow)");
    expect(route).not.toContain('select("id, name, visibility, acl, owner_user_id")');
    // the close notice's label (outside the library check) — left raw at the I-31 merge, flipped by
    // drafting-flow DF-P15 (the DACL-10 remainder): it selects the rung's columns and is judged on the
    // effective ACL, so its answer is the same before and after the paste
    expect(route).not.toContain('.from("libraries").select("name, visibility, acl").eq("id", ticket.libraryId)');
    expect(route).toContain('.from("libraries").select(`id, name, ${LIBRARY_RUNG_COLUMNS}`).eq("id", ticket.libraryId)');
    expect(route).toContain("const libLabel = libraryLabelForTicket(libRow ? libraryChoiceFromRow(libRow as unknown as Record<string, unknown>) : null);");
    const header = SQL.slice(0, SQL.indexOf("CREATE OR REPLACE TEMP VIEW"));
    expect(header).toMatch(/the ticket close notice's library label/);
  });

  it("the header names what still reads the raw ACL and the triage readers' move onto the rung (DACL-13 R1), never 'the paste changes nothing'", () => {
    const header = SQL.slice(0, SQL.indexOf("CREATE OR REPLACE TEMP VIEW"));
    expect(header).not.toMatch(/NO ONE'S ACCESS CHANGES AT THE PASTE\./);
    expect(header).toMatch(/THE TICKET TRIAGE READERS TAKE THE RUNG \(DACL-13 R1 — ruled by the\s+-- integrator at the I-31 merge, 2026-10-20, DEC-90/);
    expect(header).toMatch(/WHAT STILL READS THE RAW ACL/);
    for (const reader of ["offerableLibraries", "app/api/tickets/workflow-action", "libraryLabelForTicket", "View-as simulator", "LIBRARY_RUNG_COLUMNS"]) expect(header, reader).toContain(reader);
    expect(header).toMatch(/inventory rows 13 \/ 14/);
    expect(header).not.toMatch(/WHAT DOES CHANGE AT THE PASTE/);
    const record = src("audit-reports/intelligence/06-document-acl-leaks.md");
    expect(record).toMatch(/<a id="dacl-13"><\/a>/);
    expect(record).not.toMatch(/No one's answer changes at the paste \(proved\)/);
  });

  it("DACL-13 R2: the private / hidden LISTING that follows the paste is ACCEPTED and said precisely — every row whose acl_index is built or rebuilt, at once on upload / folder create / move / drawer save, existing rows at the latest at the next nightly rebuild; row 12 an upper bound", () => {
    const header = SQL.slice(0, SQL.indexOf("CREATE OR REPLACE TEMP VIEW"));
    expect(header).toMatch(/WHAT WIDENS AFTER THE PASTE \(said, not hidden — ACCEPTED: DACL-13 R2,\s+-- ruled by the integrator at the I-31 merge, 2026-10-20, DEC-90\)/);
    expect(header).toMatch(/From the paste on, every private \/ hidden row in a written library\s+-- whose acl_index is built or rebuilt takes the library's rung — at once on\s+-- upload, folder create, move or drawer save, and for existing rows at the\s+-- latest at the next nightly rebuild/);
    expect(header).toMatch(/it adds nothing\s+-- the app does not already show them/);
    expect(header).toMatch(/Inventory row 12 is up to that many\s+-- rows \(an upper bound: rows below a non-inheriting node do not widen\)/);
    expect(header).not.toMatch(/NOT YET ACCEPTED/);
    expect(header).not.toMatch(/Within ONE nightly acl_index rebuild after the paste/);
    expect(header).not.toMatch(/WHAT CONVERGES LATER/);
    expect(CODE).toMatch(/SELECT 12, 'before: private \/ hidden documents, folders and document sets in them — up to this many rows \(an upper bound: rows below a non-inheriting node do not widen\) that the database returns to the roles the lists name once their acl_index is built or rebuilt \(at once on upload, folder create, move or drawer save; existing rows at the latest at the next nightly rebuild\)/);
    const lib = src("lib/libraryAccess.ts");
    expect(lib).not.toMatch(/the raw-ACL ticket readers\s+\/\/ excepted/);
    expect(lib).not.toMatch(/at the first\s+\/\/ acl_index rebuild after the paste/);
    expect(lib).toMatch(/once\s+\/\/ its acl_index is built or rebuilt after the paste \(at once on upload,\s+\/\/ folder create, move or drawer save; an existing row at the latest at the\s+\/\/ next nightly rebuild\)/);
    const record = src("audit-reports/intelligence/06-document-acl-leaks.md");
    const dacl10 = record.slice(record.indexOf('<a id="dacl-10"></a>'), record.indexOf('<a id="dacl-11"></a>'));
    const dacl13 = record.slice(record.indexOf('<a id="dacl-13"></a>'));
    for (const [n, rec] of [["DACL-10", dacl10], ["DACL-13", dacl13]] as const) {
      expect(rec, n).toMatch(/every private \/ hidden row whose `acl_index` is built or rebuilt — at once on upload, folder create, move or drawer save, and for existing rows at the latest at the next nightly rebuild/);
      expect(rec, n).toMatch(/up to N rows \(an upper bound: rows below a non-inheriting node do not widen\)/);
      expect(rec, n).toMatch(/Ruled by the integrator at the I-31 merge, 2026-10-20 \(DEC-90\)/);
    }
    expect(dacl13).toMatch(/- \[x\] The integrator has ruled on question 2/);
    const dec = src("audit-reports/DECISIONS.md");
    const i31 = dec.slice(dec.indexOf("I-31 LEGACY LISTS INTO THE ACL): the integrator's rulings"));
    const line = i31.slice(0, i31.indexOf("\n"));
    expect(line).toMatch(/Ruled by the integrator at the I-31 merge, 2026-10-20 \(DEC-90\)/);
    expect(line).toMatch(/every private \/ hidden row whose `acl_index` is built or rebuilt — at once on upload, folder create, move or drawer save, and for existing rows at the latest at the next nightly rebuild/);
    expect(line).not.toMatch(/put to the integrator as `DACL-13`'s question 2 for explicit acceptance/);
  });

  it("paste order: the I-31 deploy is a hard prerequisite (a pre-I-31 app's raw triage readers would change at the paste, and its library page would hide Publish from controllers once the rung's index is written)", () => {
    const facts = SQL.slice(SQL.indexOf("-- PASTE FACTS."), SQL.indexOf("-- ROLLBACK"));
    expect(facts).toMatch(/DEPLOY — HARD PREREQUISITE: deploy I-31 FIRST, then paste\./);
    expect(facts).toMatch(/on a\s+--\s+pre-I-31 app the picker and the workflow-action library check read the\s+--\s+raw ACL and would change at the paste/);
    expect(facts).toMatch(/HIDES Publish \/ Revert from controllers/);
    expect(SQL).not.toMatch(/Either order with the I-31\s+--\s+deploy/);
    for (const rec of ["audit-reports/intelligence/06-document-acl-leaks.md", "audit-reports/DECISIONS.md"]) {
      expect(src(rec), rec).not.toMatch(/either order with the I-31 deploy/i);
    }
  });

  it("paste order: no ruling gate remains — DACL-13 was ruled at the I-31 merge (R1 built in the deploy, R2 accepted); the header, DACL-10 and DEC-90 say so", () => {
    const facts = SQL.slice(SQL.indexOf("-- PASTE FACTS."), SQL.indexOf("-- ROLLBACK"));
    expect(facts).not.toMatch(/DO NOT PASTE until the integrator has ruled/);
    expect(facts).toMatch(/RULING: none outstanding\. DACL-13 was ruled by the integrator at the\s+--\s+I-31 merge \(2026-10-20, DEC-90\)/);
    const record = src("audit-reports/intelligence/06-document-acl-leaks.md");
    const dacl10 = record.slice(record.indexOf('<a id="dacl-10"></a>'), record.indexOf('<a id="dacl-11"></a>'));
    expect(dacl10).not.toMatch(/\*\*DO NOT PASTE until the integrator has ruled on `DACL-13`\.\*\*/);
    expect(dacl10).toMatch(/deploy the I-31 app BEFORE pasting `20261228`/);
    expect(record.slice(record.indexOf('<a id="dacl-13"></a>'))).not.toMatch(/\*\*The paste waits for this ruling\.\*\*/);
    const dec = src("audit-reports/DECISIONS.md");
    const i31 = dec.slice(dec.indexOf("I-31 LEGACY LISTS INTO THE ACL): the integrator's rulings"));
    expect(i31.slice(0, i31.indexOf("\n"))).not.toMatch(/\*\*and DO NOT PASTE until the integrator has ruled on `DACL-13`\*\*/);
  });

  it("the by-hand ROLLBACK restores a NULL before-value as NULL (NULLIF over the audit row's JSON null), for acl and acl_index", () => {
    const rb = SQL.slice(SQL.indexOf("-- ROLLBACK"), SQL.indexOf("-- ─", SQL.indexOf("-- ROLLBACK")));
    expect(rb).toContain("acl = NULLIF(a.details->'before'->'acl', 'null'::jsonb)");
    expect(rb).toContain("acl_index = NULLIF(a.details->'before'->'acl_index', 'null'::jsonb)");
  });
});

// ── 4. ALOG-13 ──────────────────────────────────────────────────────────────
/** The ACL the wizard writes (LibraryWizard handleSubmit), for a seed check. */
function wizardAcl(viewRoles: Role[] | "all", uploadRoles: Role[]): AccessControl {
  const adminRoles = ["Admin", "DocCtrl"] as Role[];
  const writeRoles = Array.from(new Set([...uploadRoles, ...adminRoles]));
  const rules: AccessRule[] = [];
  if (viewRoles === "all") rules.push({ effect: "allow", subject: { type: "org", id: ORG }, actions: ["discover", "read", "download"] });
  else viewRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["discover", "read", "download"] }));
  writeRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"] }));
  adminRoles.forEach((r) => rules.push({ effect: "allow", subject: { type: "role", id: r }, actions: ["admin", "managePermissions"] }));
  return { inherit: true, visibility: "normal", rules } as AccessControl;
}

describe("ALOG-13 — the wizard's upload picker is seeded from the ACL it wrote; the columns are no longer written", () => {
  it("a library the wizard saved before this change: the seed is the same list, in the same order, as its write_access column", () => {
    for (const upload of [["Engineer" as Role], [] as Role[], ["Supervisor" as Role, "Engineer" as Role, "Admin" as Role]]) {
      const writeRoles = Array.from(new Set([...upload, "Admin" as Role, "DocCtrl" as Role]));
      for (const view of [["HR" as Role], "all" as const]) {
        expect(wizardUploadRolesSeed({ acl: wizardAcl(view, upload), writeAccess: writeRoles })).toEqual(writeRoles);
      }
    }
  });

  it("a library the wizard saves from now on (no write_access): the seed comes from its ACL", () => {
    expect(wizardUploadRolesSeed({ acl: wizardAcl(["HR" as Role], ["Engineer" as Role]), writeAccess: undefined })).toEqual(["Engineer", "Admin", "DocCtrl"]);
  });

  it("a legacy library (no ACL, or the pasted read-only rung) and a Save-As library keep today's seed — the column, or the caller's default", () => {
    expect(wizardUploadRolesSeed({ acl: null, writeAccess: ["Engineer" as Role] })).toEqual(["Engineer"]);
    const rung = legacyLibraryAcl({ readAccess: ["HR" as Role], writeAccess: ["Engineer" as Role] })!;
    expect(wizardUploadRolesSeed({ acl: rung, writeAccess: ["Engineer" as Role] })).toEqual(["Engineer"]);
    expect(wizardUploadRolesSeed({ acl: null, writeAccess: [] })).toEqual([]);
    expect(wizardUploadRolesSeed({ acl: null, writeAccess: undefined })).toBeUndefined();
    expect(wizardUploadRolesSeed(null)).toBeUndefined();
  });

  it("a drawer-made rule is never taken for the picker's (another action set, a user / team subject, or an expiry) — re-emitting it would widen it", () => {
    const acl = {
      inherit: true, visibility: "normal", rules: [
        { effect: "allow", subject: { type: "role", id: "Supervisor" }, actions: ["upload", "publish"] },
        { effect: "allow", subject: { type: "user", id: "u1" }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"] },
        { effect: "allow", subject: { type: "role", id: "Vendor" }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"], expiresAt: "2030-01-01T00:00:00Z" },
        { effect: "deny", subject: { type: "role", id: "Viewer" }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"] },
      ],
    } as AccessControl;
    expect(wizardUploadRolesSeed({ acl, writeAccess: ["Engineer" as Role] })).toEqual(["Engineer"]);
  });

  it("wizardListColumnsFromAcl: from the wizard's own ACL, the same write_access / admin_access the wizard wrote before I-31 (one array fed both)", () => {
    for (const upload of [["Engineer" as Role], [] as Role[], ["Supervisor" as Role, "Engineer" as Role, "Admin" as Role]]) {
      const writeRoles = Array.from(new Set([...upload, "Admin" as Role, "DocCtrl" as Role]));
      for (const view of [["HR" as Role], "all" as const]) {
        expect(wizardListColumnsFromAcl(wizardAcl(view, upload))).toEqual({ write_access: writeRoles, admin_access: ["Admin", "DocCtrl"] });
      }
    }
    expect(wizardListColumnsFromAcl(null)).toEqual({ write_access: [], admin_access: [] });
  });

  it("a wizard edit followed by a drawer clear grants no role outside the last saved view / upload lists (the fallback never reads a stale write_access)", () => {
    // Saved by the pre-I-31 wizard: view [HR], upload [Engineer].
    const oldWrite = ["Engineer", "Admin", "DocCtrl"] as Role[];
    const before = { readAccess: ["HR"] as Role[], visibleTo: ["HR", ...oldWrite] as Role[], writeAccess: oldWrite, adminAccess: ["Admin", "DocCtrl"] as Role[], visibility: "normal" as const };
    // After the I-31 deploy an Admin edits it and removes Engineer from upload.
    const acl = wizardAcl(["HR" as Role], []);
    const editLists = wizardListColumnsFromAcl(acl);
    const writeRoles = ["Admin", "DocCtrl"] as Role[];
    const edited = { ...before, visibleTo: Array.from(new Set(["HR" as Role, ...writeRoles])), writeAccess: editLists.write_access, adminAccess: editLists.admin_access, acl };
    // Later a controller clears every rule in the drawer: a zero-rule, normal ACL.
    const cleared = { ...edited, acl: { inherit: true, visibility: "normal", rules: [] } as AccessControl };
    const rung = legacyLibraryAcl(cleared)!;
    const granted = new Set(rung.rules.map((r) => String(r.subject.id)));
    expect(granted.has("Engineer")).toBe(false);
    for (const g of granted) expect(["HR", ...writeRoles]).toContain(g);
    // The edit that stopped writing the column would have left Engineer's read in the fallback.
    const frozen = legacyLibraryAcl({ ...cleared, writeAccess: oldWrite })!;
    expect(frozen.rules.map((r) => String(r.subject.id))).toContain("Engineer");
    // The library page answers by the same rung.
    expect(canWithAclChain({ principal: PRINCIPALS.engineer, action: "read", aclChain: [rung] })).toBe(false);
    expect(canWithAclChain({ principal: PRINCIPALS.hr, action: "read", aclChain: [rung] })).toBe(true);
  });

  it("R3: a wizard EDIT writes write_access / admin_access exactly as wizardUploadRolesSeed reads them back from the ACL it stores; a drawer clear after it re-grants no role outside the last saved view / upload", () => {
    for (const upload of [["Engineer" as Role], [] as Role[], ["Supervisor" as Role, "Engineer" as Role]]) {
      for (const view of [["HR" as Role], ["HR" as Role, "Vendor" as Role]]) {
        const form = wizardAcl(view, upload);
        // a drawer grant already on the library (a user / team grant, an expiring role grant) survives the merge
        const drawer = [
          { effect: "allow", subject: { type: "user", id: "u9" }, actions: ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"] },
          { effect: "allow", subject: { type: "role", id: "Vendor" }, actions: ["read"], expiresAt: "2030-01-01T00:00:00Z" },
        ] as AccessRule[];
        const stored = mergeWizardLibraryAcl(form, drawer)!;
        const lists = wizardListColumnsFromAcl(form);
        expect(wizardUploadRolesSeed({ acl: stored, writeAccess: lists.write_access })).toEqual(lists.write_access);
        expect(wizardUploadRolesSeed({ acl: stored, writeAccess: undefined })).toEqual(lists.write_access);
        // the drawer later clears the ACL: the fallback reads the lists the edit wrote — the last saved roles only
        const visibleTo = Array.from(new Set([...view, ...lists.write_access]));
        const rung = legacyLibraryAcl({ readAccess: view, visibleTo, writeAccess: lists.write_access, adminAccess: lists.admin_access, acl: { inherit: true, visibility: "normal", rules: [] } as AccessControl })!;
        const saved = new Set<string>([...view, ...upload, "Admin", "DocCtrl"]);
        for (const r of rung.rules) expect(saved.has(String(r.subject.id)), String(r.subject.id)).toBe(true);
      }
    }
  });

  it("a NEW library's writers name no write_access / admin_access; a wizard EDIT writes them from the wizard's ACL; the wizard's payload carries no writeAccess / adminAccess; the console comment says where the lists are read", () => {
    const page = src("app/(protected)/admin/libraries/page.tsx");
    const dbConfig = page.slice(page.indexOf("const dbConfig = {"), page.indexOf("};", page.indexOf("const dbConfig = {")));
    expect(dbConfig).not.toMatch(/\b(write|admin)_access\s*:/);
    expect(dbConfig).toMatch(/read_access: config\.readAccess \?\? "ALL", visible_to: config\.visibleTo \?\? \[\]/);
    expect(page).toContain("const editLists = wizardListColumnsFromAcl(config.acl);");
    expect(page).toContain(".update({ ...dbConfig, ...editLists, updated_at: now, updated_by: uid })");
    const pageInsert = page.slice(page.indexOf(".insert({ ...dbConfig"), page.indexOf("\n", page.indexOf(".insert({ ...dbConfig")));
    expect(pageInsert).toContain("org_id: activeOrgId");
    expect(pageInsert).not.toMatch(/editLists|wizardListColumnsFromAcl|_access/);
    const lc = src("lib/libraryCollections.ts");
    const insert = lc.slice(lc.indexOf("export async function createLibrary"), lc.indexOf(".select(\"id, name\")"));
    expect(insert).not.toMatch(/\b(write|admin)_access\s*:/);
    expect(insert).toMatch(/read_access: "ALL"/);
    const wiz = src("app/(protected)/admin/libraries/LibraryWizard.tsx");
    const payload = wiz.slice(wiz.indexOf("await onSave({"), wiz.indexOf("} as Omit<LibraryConfig, \"id\">);"));
    expect(payload).not.toMatch(/^\s*(writeAccess|adminAccess)\s*:/m);
    expect(payload).toMatch(/^\s*acl,$/m);
    expect(wiz).toContain('setUploadRoles(wizardUploadRolesSeed(initialData) ?? ["DocCtrl", "Admin"]);');
    const consoleSrc = src("app/(protected)/admin/permissions/page.tsx");
    expect(consoleSrc).not.toMatch(/matrix is GONE/);
    expect(consoleSrc).toMatch(/libraryReadsByRole/);
    expect(consoleSrc).toMatch(/legacyLibraryAcl/);
    expect(consoleSrc).toMatch(/20261228/);
  });
});
