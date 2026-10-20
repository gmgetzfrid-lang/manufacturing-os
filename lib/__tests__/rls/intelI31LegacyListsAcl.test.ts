// intelligence I-31 — 20261228 writes each legacy library's role lists into
// libraries.acl, run on PostgreSQL 16 against the replayed database (DEC-90's
// I-31 rulings: exactly the rung the app's legacy rung evaluates today; counts
// first; idempotent; only rows whose ACL says nothing while their lists
// restrict; no RESTRICTIVE policy on libraries; node_visible untouched).
//
// The equivalence, member by member and library by library, on one fixture:
//
//   · the APP'S answer BEFORE the paste — lib/libraryAccess over the row as
//     the database holds it (effectiveLibraryAclFromRow: the fallback rung
//     for a legacy library), for the library itself (explorerLibraryVisible —
//     the library page's "you don't have access") and for each probe
//     document in it (lib/permissions canReadNode — the AI seam's and the
//     bytes door's read predicate);
//   · the APP'S answer AFTER the paste — the same functions over the row read
//     back from the database (now the ACL decides);
//   · the DATABASE'S answer — documents_acl_select as that member, for a
//     PRIVATE probe document whose chain-resolved acl_index is what the app's
//     own rebuild (lib/acl buildAclIndexFromChain) writes from the library's
//     ACL after the paste; and the library row itself (libraries_org_access).
//
// Folders and document sets too (the integrator's minor (b) at the I-31
// merge, 2026-10-20, DEC-90): their acl_index is rebuilt before and after
// the paste the way the app's rebuild writes it (buildAclIndexFromChain
// over [library ACL, …ancestor folder ACLs, folder ACL] / [library ACL, set
// ACL]); per member nobody loses a row at the database, every row that
// widens reaches a listed role only (DACL-13 R2, accepted), a row below a
// non-inheriting folder does not widen (inventory row 12 is an upper bound),
// and on folders the database's answer equals the app's explorerFolderVisible
// after the rebuild (private / hidden folders; a normal folder stays open at
// the database until intelligence I-30, as for documents).
//
// Controllers (a headline Admin and an additive DocCtrl — DEC-43), the
// library's owner, deeper grants (a folder's role grant, a document's user
// grant), hidden / private visibility, a list naming no role, a malformed
// list, duplicate and non-string list entries, and the untouched cases (a
// read_access of "ALL" or NULL — the Everyone case — and an ACL that already
// says something) are all in the fixture.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";
import { effectiveLibraryAclFromRow, explorerFolderVisible, explorerLibraryVisible, libraryConfigFromRow } from "@/lib/libraryAccess";
import { buildAclIndexFromChain } from "@/lib/acl";
import { canReadNode, type Principal } from "@/lib/permissions";
import type { AccessControl, Role } from "@/types/schema";

const skip = skipReason();
const FILE = "20261228_intel_roundG_legacy_lists_into_acl.sql";
const SQL = readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

interface Row { check: string; ok: string; n: string }
interface Paste { rows: Row[]; ok: boolean; error: string | null }

function paste(db: string): Paste {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, "postgres", { sql: SQL });
  const rows = r.stdout.split("\n").filter((l) => l.includes("|")).map((l) => {
    const parts = l.split("|");
    return { check: parts.slice(0, -2).join("|"), ok: parts.at(-2)!, n: parts.at(-1)! };
  });
  return { rows, ok: r.ok, error: r.error };
}
const inv = (p: Paste, startsWith: string): string => {
  const found = p.rows.filter((r) => r.check.startsWith(startsWith));
  expect(found, startsWith).toHaveLength(1);
  return found[0].n;
};

type Lib = {
  key: string;
  readAccess: unknown;
  visibleTo?: unknown;
  writeAccess?: unknown;
  adminAccess?: unknown;
  acl?: unknown;
  visibility?: string | null;
  owner?: string;
  /** Will 20261228 write it? */
  written: boolean;
};

const rule = (subject: object, ...actions: string[]) => ({ effect: "allow", subject, actions });

describe.skipIf(skip !== null)("20261228 — a legacy library's lists into its ACL: the app before, the app after and the database agree (PostgreSQL 16)", () => {
  const scratch = `mos_i31_lists_${process.pid}`;
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const libId: Record<string, string> = {};
  const before: Record<string, Record<string, unknown>> = {};
  let after: Record<string, Record<string, unknown>> = {};
  let first: Paste = { rows: [], ok: false, error: null };
  let second: Paste = { rows: [], ok: false, error: null };
  /** Probe documents: library key → { doc key → { id, acl, folderAcl, visibility } }. */
  const docs: Array<{ lib: string; key: string; id: string; visibility: "normal" | "private"; acl: AccessControl | null; folderAcl: AccessControl | null; folderId: string | null }> = [];
  /** Probe folders (pathIds root first) and document sets. */
  const folders: Array<{ lib: string; key: string; id: string; visibility: "normal" | "private" | "hidden"; acl: AccessControl | null; pathIds: string[] }> = [];
  const sets: Array<{ lib: string; key: string; id: string; visibility: string; acl: AccessControl | null }> = [];
  /** The database's answers before the paste (indexes from the pre-paste library ACLs), read in the equivalence test. */
  const dbFolderBefore: Record<string, Record<string, boolean>> = {};
  const dbSetBefore: Record<string, Record<string, boolean>> = {};

  const LIBS: Lib[] = [];
  const memberKeys = ["admin", "addCtrl", "hr", "engineer", "supervisor", "vendor", "owner", "multi"] as const;

  const rowOf = (db: string, id: string): Record<string, unknown> =>
    JSON.parse(admin(db, `SELECT row_to_json(l)::text FROM (SELECT id, org_id, acl, acl_index, visibility, owner_user_id, read_access, visible_to, write_access, admin_access FROM libraries WHERE id = '${id}') l`));
  const allRows = (db: string) => Object.fromEntries(LIBS.map((l) => [l.key, rowOf(db, libId[l.key])]));

  const principalOf = (key: string): Principal => {
    const spec: Record<string, { role: Role; roles?: Role[] }> = {
      admin: { role: "Admin" as Role }, addCtrl: { role: "Viewer" as Role, roles: ["DocCtrl" as Role] },
      hr: { role: "HR" as Role }, engineer: { role: "Engineer" as Role }, supervisor: { role: "Supervisor" as Role },
      vendor: { role: "Vendor" as Role }, owner: { role: "Viewer" as Role }, multi: { role: "Viewer" as Role, roles: ["HR" as Role] },
    };
    const s = spec[key];
    return { uid: m[key].uid, role: s.role, roles: s.roles ?? [], orgId, teamIds: [], isActiveMember: true };
  };

  /** The app's answers over a library row: the library itself, then each probe document. */
  const appAnswers = (row: Record<string, unknown>, lib: Lib, who: string): Record<string, boolean> => {
    const principal = principalOf(who);
    const cfg = libraryConfigFromRow(row);
    const rung = effectiveLibraryAclFromRow(row);
    const out: Record<string, boolean> = {
      library: explorerLibraryVisible(principal, cfg),
    };
    for (const d of docs.filter((x) => x.lib === lib.key)) {
      out[d.key] = canReadNode({
        principal,
        aclChain: [rung ?? null, d.folderAcl, d.acl],
        visibility: d.visibility,
        effectiveOwnerUserId: (row.owner_user_id as string | null) ?? null,
      });
    }
    return out;
  };

  /** The database's answer for each probe document, as that member. */
  const dbDocAnswers = (lib: Lib, who: string): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const d of docs.filter((x) => x.lib === lib.key)) {
      out[d.key] = selectAs(scratch, m[who].caller, `SELECT count(*) FROM documents WHERE id = '${d.id}'`)[0] === "1";
    }
    return out;
  };
  const dbLibraryRow = (lib: Lib, who: string) =>
    selectAs(scratch, m[who].caller, `SELECT count(*) FROM libraries WHERE id = '${libId[lib.key]}'`)[0] === "1";

  /** What the app's rebuild (lib/aclIndexRebuild) writes into each probe
   *  document's, folder's and set's acl_index from the library's CURRENT ACL. */
  const rebuildDocIndexes = () => {
    const sqlIdx = (idx: unknown) => (idx ? `'${JSON.stringify(idx)}'::jsonb` : "NULL");
    for (const d of docs) {
      const libAcl = (rowOf(scratch, libId[d.lib]).acl ?? undefined) as AccessControl | undefined;
      const idx = buildAclIndexFromChain([libAcl, d.folderAcl ?? undefined, d.acl ?? undefined]);
      admin(scratch, `UPDATE documents SET acl_index = ${sqlIdx(idx)} WHERE id = '${d.id}'`);
    }
    for (const f of folders) {
      const libAcl = (rowOf(scratch, libId[f.lib]).acl ?? undefined) as AccessControl | undefined;
      const ancestors = f.pathIds.map((pid) => folders.find((x) => x.id === pid)?.acl ?? undefined);
      const idx = buildAclIndexFromChain([libAcl, ...ancestors, f.acl ?? undefined]);
      admin(scratch, `UPDATE collections SET acl_index = ${sqlIdx(idx)} WHERE id = '${f.id}'`);
    }
    for (const t of sets) {
      const libAcl = (rowOf(scratch, libId[t.lib]).acl ?? undefined) as AccessControl | undefined;
      const idx = buildAclIndexFromChain([libAcl, t.acl ?? undefined]);
      admin(scratch, `UPDATE document_sets SET acl_index = ${sqlIdx(idx)} WHERE id = '${t.id}'`);
    }
  };
  const dbFolder = (id: string, who: string) => selectAs(scratch, m[who].caller, `SELECT count(*) FROM collections WHERE id = '${id}'`)[0] === "1";
  const dbSet = (id: string, who: string) => selectAs(scratch, m[who].caller, `SELECT count(*) FROM document_sets WHERE id = '${id}'`)[0] === "1";
  /** The app's folder decision (the library page's explorerFolderVisible) over a library row. */
  const appFolder = (row: Record<string, unknown>, f: (typeof folders)[number], who: string): boolean => {
    const map = new Map(folders.filter((x) => x.lib === f.lib).map((x) => [x.id, { id: x.id, pathIds: x.pathIds, acl: x.acl ?? undefined, visibility: x.visibility }]));
    return explorerFolderVisible(principalOf(who), effectiveLibraryAclFromRow(row), map.get(f.id)!, map, (row.owner_user_id as string | null) ?? null);
  };

  beforeAll(() => {
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${REPLAY_DB}`);
    admin(scratch, "SET session_replication_role = replica; DELETE FROM documents; DELETE FROM collections; DELETE FROM document_sets; DELETE FROM libraries;");
    const s = seedOrg(scratch, {
      admin: { role: "Admin" }, addCtrl: { role: "Viewer", roles: ["DocCtrl"] },
      hr: { role: "HR" }, engineer: { role: "Engineer" }, supervisor: { role: "Supervisor" },
      vendor: { role: "Vendor" }, owner: { role: "Viewer" }, multi: { role: "Viewer", roles: ["HR"] },
    });
    orgId = s.orgId;
    m = s.m;

    const wizardEveryone = { inherit: true, visibility: "normal", rules: [
      rule({ type: "org", id: orgId }, "discover", "read", "download"),
      rule({ type: "role", id: "Admin" }, "upload", "createFolder", "editMetadata", "write", "download", "read", "discover"),
    ] };
    LIBS.push(
      { key: "A_null_hr_write_engineer_owned", readAccess: ["HR"], writeAccess: ["Engineer"], acl: null, owner: m.owner.uid, written: true },
      { key: "B_zero_rule_hr_visible_supervisor", readAccess: ["HR"], visibleTo: ["Supervisor"], acl: { inherit: true, visibility: "normal", rules: [] }, written: true },
      { key: "C_no_role", readAccess: [], acl: null, written: true },
      { key: "D_no_role_hidden", readAccess: [], acl: null, visibility: "hidden", written: true },
      { key: "E_malformed_list", readAccess: "weird", acl: null, written: true },
      { key: "F_duplicates_and_garbage", readAccess: ["HR", "HR"], visibleTo: ["HR", "Engineer"], adminAccess: ["Engineer", 5, null], acl: null, written: true },
      { key: "G_all", readAccess: "ALL", acl: null, written: false },
      { key: "H_null_read", readAccess: null, acl: "null", written: false },
      { key: "I_wizard_everyone", readAccess: "ALL", acl: wizardEveryone, written: false },
      { key: "J_acl_says_something", readAccess: ["HR"], acl: { inherit: true, visibility: "normal", rules: [rule({ type: "role", id: "Engineer" }, "discover", "read", "download")] }, written: false },
      { key: "K_private_zero_rule", readAccess: ["HR"], acl: { inherit: true, visibility: "private", rules: [] }, written: false },
      { key: "L_deeper_folder_grant", readAccess: ["HR"], acl: null, written: true },
    );
    const j = (v: unknown) => (v === undefined ? "'[]'::jsonb" : v === null ? "NULL" : `'${JSON.stringify(v)}'::jsonb`);
    for (const l of LIBS) {
      const id = randomUUID();
      libId[l.key] = id;
      const aclSql = l.acl === "null" ? "'null'::jsonb" : j(l.acl);
      admin(scratch, `INSERT INTO libraries (id, org_id, name, type, acl, read_access, visible_to, write_access, admin_access, visibility, owner_user_id)
        VALUES ('${id}', '${orgId}', '${l.key}', 'documents', ${aclSql}, ${j(l.readAccess)}, ${j(l.visibleTo)}, ${j(l.writeAccess)}, ${j(l.adminAccess)},
                ${l.visibility ? `'${l.visibility}'` : "'normal'"}, ${l.owner ? `'${l.owner}'` : "NULL"})`);
    }
    // Probe documents: a private and a normal one in every library; a
    // private one granted to the vendor by user in A; a private one in a
    // folder of L that grants the Vendor role.
    const privateAcl: AccessControl = { inherit: true, visibility: "private", rules: [] } as AccessControl;
    const addDoc = (lib: string, key: string, visibility: "normal" | "private", acl: AccessControl | null, folderAcl: AccessControl | null = null, folderId: string | null = null) => {
      const id = randomUUID();
      admin(scratch, `INSERT INTO documents (id, org_id, library_id, collection_id, name, title, document_number, rev, status, visibility, acl)
        VALUES ('${id}', '${orgId}', '${libId[lib]}', ${folderId ? `'${folderId}'` : "NULL"}, 'p.pdf', 'Probe', 'P-${id.slice(0, 8)}', '0', 'Draft', '${visibility}', ${acl ? `'${JSON.stringify(acl)}'::jsonb` : "NULL"})`);
      docs.push({ lib, key, id, visibility, acl, folderAcl, folderId });
    };
    for (const l of LIBS) {
      addDoc(l.key, "private", "private", privateAcl);
      addDoc(l.key, "normal", "normal", null);
    }
    addDoc("A_null_hr_write_engineer_owned", "private_user_grant_vendor", "private",
      { inherit: true, visibility: "private", rules: [rule({ type: "user", id: m.vendor.uid }, "discover", "read")] } as AccessControl);
    const folderId = randomUUID();
    const folderAcl = { inherit: true, visibility: "normal", rules: [rule({ type: "role", id: "Vendor" }, "discover", "read")] } as AccessControl;
    admin(scratch, `INSERT INTO collections (id, org_id, library_id, name, visibility, acl) VALUES ('${folderId}', '${orgId}', '${libId.L_deeper_folder_grant}', 'Vendor folder', 'normal', '${JSON.stringify(folderAcl)}'::jsonb)`);
    folders.push({ lib: "L_deeper_folder_grant", key: "vendor_folder", id: folderId, visibility: "normal", acl: folderAcl, pathIds: [] });
    addDoc("L_deeper_folder_grant", "private_in_vendor_folder", "private", privateAcl, folderAcl, folderId);
    // Probe folders (minor (b) at the I-31 merge): private / hidden folders in
    // written libraries whose lists name a role (A, F — counted by inventory
    // row 12), a non-inheriting private folder and a private folder below it
    // (counted by row 12, an upper bound: neither widens), a private folder in
    // a written library naming no role (C), one in an unwritten library (J),
    // and a normal one (B).
    const addFolder = (lib: string, key: string, visibility: "normal" | "private" | "hidden", acl: AccessControl | null, parent: string | null = null) => {
      const id = randomUUID();
      const pathIds = parent ? [...folders.find((x) => x.id === parent)!.pathIds, parent] : [];
      admin(scratch, `INSERT INTO collections (id, org_id, library_id, parent_id, path_ids, name, visibility, acl) VALUES ('${id}', '${orgId}', '${libId[lib]}', ${parent ? `'${parent}'` : "NULL"}, '{${pathIds.join(",")}}'::uuid[], '${key}', '${visibility}', ${acl ? `'${JSON.stringify(acl)}'::jsonb` : "NULL"})`);
      folders.push({ lib, key, id, visibility, acl, pathIds });
      return id;
    };
    const privateFolder = { inherit: true, visibility: "private", rules: [] } as AccessControl;
    addFolder("A_null_hr_write_engineer_owned", "private_folder", "private", privateFolder);
    const noInherit = addFolder("A_null_hr_write_engineer_owned", "private_no_inherit", "private", { inherit: false, visibility: "private", rules: [] } as AccessControl);
    addFolder("A_null_hr_write_engineer_owned", "private_below_no_inherit", "private", privateFolder, noInherit);
    addFolder("B_zero_rule_hr_visible_supervisor", "normal_folder", "normal", null);
    addFolder("C_no_role", "private_folder", "private", privateFolder);
    addFolder("F_duplicates_and_garbage", "hidden_folder", "hidden", { inherit: true, visibility: "hidden", rules: [] } as AccessControl);
    addFolder("J_acl_says_something", "private_folder", "private", privateFolder);
    // Document sets (inventory row 12 counts the private / hidden ones in a
    // written library whose lists name a role — the rebuild folds the
    // library's rung into each set's index, lib/aclIndexRebuild): A private
    // and F hidden are counted; C hidden (no role), J private (not written)
    // and B normal are not.
    for (const [lib, vis] of [["A_null_hr_write_engineer_owned", "private"], ["F_duplicates_and_garbage", "hidden"],
                              ["C_no_role", "hidden"], ["J_acl_says_something", "private"], ["B_zero_rule_hr_visible_supervisor", "normal"]] as const) {
      const id = randomUUID();
      admin(scratch, `INSERT INTO document_sets (id, org_id, library_id, title, visibility) VALUES ('${id}', '${orgId}', '${libId[lib]}', 'Probe set', '${vis}')`);
      sets.push({ lib, key: `${vis}_set`, id, visibility: vis, acl: null });
    }

    Object.assign(before, allRows(scratch));
  });
  afterAll(() => {
    try { admin("postgres", `DROP DATABASE IF EXISTS ${scratch}`); } catch { /* the cluster is deleted after the run anyway */ }
  });

  it("the replayed fresh install ran 20261228 without error", () => {
    const out = mosDb().report!.files.find((f) => f.file === FILE);
    expect(out, FILE).toBeDefined();
    expect(out!.error).toBeNull();
    expect(out!.ok).toBe(true);
  });

  it("the paste: one result set, every probe true, and the counts-only inventory counts exactly the fixture", () => {
    // The database's answer for private rows BEFORE the paste, with indexes
    // the app's rebuild writes from today's (empty) library ACLs.
    rebuildDocIndexes();
    first = paste(scratch);
    expect(first.error).toBeNull();
    expect(first.ok).toBe(true);
    const probes = first.rows.filter((r) => r.ok === "t" || r.ok === "f");
    expect(probes.length).toBe(7);
    for (const p of probes) expect(p.ok, p.check).toBe("t");
    for (const r of first.rows) expect(r.check.length).toBeGreaterThan(0);
    expect(inv(first, "before: libraries (every workspace)")).toBe("12");
    expect(inv(first, "before: libraries whose read_access is restricted (neither")).toBe("9");
    expect(inv(first, "before: of those, libraries whose ACL is NULL")).toBe("6");
    expect(inv(first, "before: of those, libraries whose ACL is present but says nothing")).toBe("1");
    expect(inv(first, "before: libraries this paste writes")).toBe("7");
    expect(inv(first, "before: of those, libraries whose lists name no role")).toBe("3");
    expect(inv(first, "before: role grants this paste writes")).toBe("9");
    expect(inv(first, "before: libraries whose read_access is restricted and whose ACL already says something")).toBe("2");
    expect(inv(first, "before: libraries whose read_access is \"ALL\" or NULL")).toBe("3");
    expect(inv(first, "before: documents filed in the libraries this paste writes")).toBe("16");
    expect(inv(first, "before: folders in the libraries this paste writes")).toBe("7");
    expect(inv(first, "before: private / hidden documents, folders and document sets in them")).toBe("12");
    expect(inv(first, "before: (library, member) pairs the lists leave out")).toBe("30");
    expect(inv(first, "before: of those pairs, distinct members")).toBe("6");
    expect(inv(first, "this paste: libraries written")).toBe("7");
    expect(inv(first, "this paste: NODE_ACL_CHANGED audit rows written")).toBe("7");
    expect(inv(first, "after: libraries whose ACL says nothing while read_access is restricted")).toBe("0");
    expect(inv(first, "after: libraries whose ACL is exactly the rung their lists stand for")).toBe("7");
    // Never a customer row: no library id or name in the result set.
    const text = first.rows.map((r) => `${r.check}|${r.n}`).join("\n");
    for (const l of LIBS) {
      expect(text).not.toContain(libId[l.key]);
      expect(text).not.toContain(l.key);
    }
    after = allRows(scratch);
  });

  it("each written library's ACL is EXACTLY the rung lib/libraryAccess synthesized for it before the paste, and its index is lib/acl's for that ACL", () => {
    for (const l of LIBS.filter((x) => x.written)) {
      const synthesized = effectiveLibraryAclFromRow(before[l.key]);
      expect(synthesized, l.key).toBeDefined();
      expect(after[l.key].acl, l.key).toEqual(JSON.parse(JSON.stringify(synthesized)));
      expect(after[l.key].acl_index ?? null, l.key).toEqual(JSON.parse(JSON.stringify(buildAclIndexFromChain([synthesized]))));
      // …and after the paste the app's rung IS the ACL (no fallback).
      expect(effectiveLibraryAclFromRow(after[l.key]), l.key).toEqual(after[l.key].acl);
    }
    // Spot checks of the rules the paste wrote.
    expect((after.A_null_hr_write_engineer_owned.acl as AccessControl).rules.map((r) => r.subject.id)).toEqual(["HR", "Engineer"]);
    expect((after.B_zero_rule_hr_visible_supervisor.acl as AccessControl).rules.map((r) => r.subject.id)).toEqual(["HR", "Supervisor"]);
    expect((after.F_duplicates_and_garbage.acl as AccessControl).rules.map((r) => r.subject.id)).toEqual(["HR", "Engineer", 5, null]);
    expect(after.C_no_role.acl).toEqual({ inherit: true, visibility: "private", rules: [] });
    expect(after.D_no_role_hidden.acl).toEqual({ inherit: true, visibility: "hidden", rules: [] });
    expect(after.E_malformed_list.acl).toEqual({ inherit: true, visibility: "private", rules: [] });
    expect(after.C_no_role.acl_index).toBeNull();
    for (const r of (after.A_null_hr_write_engineer_owned.acl as AccessControl).rules) {
      expect(r).toEqual({ effect: "allow", subject: { type: "role", id: r.subject.id }, actions: ["discover", "read", "download"] });
    }
  });

  it("nothing else moved: untouched libraries keep their ACL and index byte for byte; every library keeps its lists and visibility", () => {
    for (const l of LIBS) {
      for (const c of ["read_access", "visible_to", "write_access", "admin_access", "visibility", "owner_user_id"]) {
        expect(after[l.key][c], `${l.key}.${c}`).toEqual(before[l.key][c]);
      }
      if (!l.written) {
        expect(after[l.key].acl, l.key).toEqual(before[l.key].acl);
        expect(after[l.key].acl_index, l.key).toEqual(before[l.key].acl_index);
      }
    }
    // One audit row per written library, reconstructable (before / after).
    const audits = admin(scratch, `SELECT count(*) FROM audit_logs WHERE action = 'NODE_ACL_CHANGED' AND resource_type = 'library' AND user_email = 'system:migration-20261228' AND org_id = '${orgId}' AND details->>'reason' = 'legacy_lists_into_acl' AND details->'after'->'acl' IS NOT NULL`);
    expect(audits).toBe("7");
  });

  it("for every member and every library: the app's answer before the paste = its answer after = the database's answer (private rows, once the rebuild folds the library's ACL into their index)", () => {
    const dbBefore: Record<string, Record<string, Record<string, boolean>>> = {};
    // dbBefore was taken with indexes built from the pre-paste ACLs; re-read
    // them now from the same indexes (unchanged by the paste — it never
    // touches documents), then rebuild from the new library ACLs.
    for (const l of LIBS) {
      dbBefore[l.key] = {};
      for (const who of memberKeys) dbBefore[l.key][who] = dbDocAnswers(l, who);
    }
    for (const f of folders) dbFolderBefore[f.id] = Object.fromEntries(memberKeys.map((who) => [who, dbFolder(f.id, who)]));
    for (const t of sets) dbSetBefore[t.id] = Object.fromEntries(memberKeys.map((who) => [who, dbSet(t.id, who)]));
    rebuildDocIndexes();
    const mismatches: string[] = [];
    const widened: string[] = [];
    for (const l of LIBS) {
      for (const who of memberKeys) {
        const a0 = appAnswers(before[l.key], l, who);
        const a1 = appAnswers(after[l.key], l, who);
        expect(a1, `${l.key} / ${who}: the app before and after`).toEqual(a0);
        const db = dbDocAnswers(l, who);
        expect(dbLibraryRow(l, who), `${l.key} / ${who}: the library row stays readable (no RESTRICTIVE policy)`).toBe(true);
        for (const d of docs.filter((x) => x.lib === l.key)) {
          // Normal rows stay open at the database for every member until
          // intelligence I-30 (DEC-90 R5) — unchanged by the paste.
          if (d.visibility === "normal") {
            expect(db[d.key], `${l.key}/${d.key}/${who}: normal row at the database`).toBe(true);
            expect(dbBefore[l.key][who][d.key]).toBe(true);
            continue;
          }
          // Nobody loses a private row at the database.
          if (dbBefore[l.key][who][d.key]) expect(db[d.key], `${l.key}/${d.key}/${who}: kept`).toBe(true);
          else if (db[d.key]) widened.push(`${l.key}/${d.key}/${who}`);
          if (l.key === "I_wizard_everyone") continue; // asserted below (the org bucket is intelligence I-30's)
          if (db[d.key] !== a1[d.key]) mismatches.push(`${l.key}/${d.key}/${who}: app ${a1[d.key]} db ${db[d.key]}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // The one database answer that moves (inventory row 12): a private row in
    // a written library reaches the roles its lists name once the rebuild
    // folds the library's ACL into its index — each one a row the app's doors
    // already let that member read (the mismatch check above). On this
    // fixture: A's two private rows and B's, F's and L's (two in L), for the
    // listed roles held by headline or additively — 16 (member, row) pairs.
    expect(widened.length).toBe(16);
    expect(widened.every((w) => /\/(hr|engineer|supervisor|multi)$/.test(w))).toBe(true);
  });

  it("folders (collections_acl_select) and document sets (document_sets_acl_select), rebuilt after the paste: nobody loses a row, every widened row reaches a listed role only, a row below a non-inheriting folder does not widen, and the database's folder answer equals explorerFolderVisible", () => {
    // (the equivalence test above read the pre-paste answers and rebuilt every index from the new library ACLs)
    expect(Object.keys(dbFolderBefore)).toHaveLength(folders.length);
    const lost: string[] = [];
    const widenedFolders: string[] = [];
    const widenedSets: string[] = [];
    const mismatches: string[] = [];
    for (const f of folders) {
      const lib = LIBS.find((l) => l.key === f.lib)!;
      for (const who of memberKeys) {
        const db = dbFolder(f.id, who);
        const a0 = appFolder(before[lib.key], f, who);
        const a1 = appFolder(after[lib.key], f, who);
        expect(a1, `${f.lib}/${f.key}/${who}: the app before and after`).toBe(a0);
        if (f.visibility === "normal") {
          // open at the database until intelligence I-30 (DEC-90 R5), before and after
          expect(db, `${f.lib}/${f.key}/${who}: normal folder at the database`).toBe(true);
          expect(dbFolderBefore[f.id][who]).toBe(true);
          continue;
        }
        if (dbFolderBefore[f.id][who] && !db) lost.push(`${f.lib}/${f.key}/${who}`);
        if (!dbFolderBefore[f.id][who] && db) widenedFolders.push(`${f.lib}/${f.key}/${who}`);
        if (db !== a1) mismatches.push(`${f.lib}/${f.key}/${who}: app ${a1} db ${db}`);
      }
    }
    for (const t of sets) {
      for (const who of memberKeys) {
        const db = dbSet(t.id, who);
        if (t.visibility === "normal") { expect(db, `${t.lib}/${t.key}/${who}`).toBe(true); continue; }
        if (dbSetBefore[t.id][who] && !db) lost.push(`${t.lib}/${t.key}/${who}`);
        if (!dbSetBefore[t.id][who] && db) widenedSets.push(`${t.lib}/${t.key}/${who}`);
      }
    }
    expect(lost).toEqual([]);
    expect(mismatches).toEqual([]);
    // widened rows reach a role the lists name, never anyone else (DACL-13 R2)
    for (const w of [...widenedFolders, ...widenedSets]) expect(w).toMatch(/\/(hr|engineer|supervisor|multi)$/);
    // A's private folder (HR, Engineer: hr, engineer, multi) and F's hidden folder (HR, Engineer: hr, engineer, multi)
    expect(widenedFolders.sort()).toEqual([
      "A_null_hr_write_engineer_owned/private_folder/engineer", "A_null_hr_write_engineer_owned/private_folder/hr", "A_null_hr_write_engineer_owned/private_folder/multi",
      "F_duplicates_and_garbage/hidden_folder/engineer", "F_duplicates_and_garbage/hidden_folder/hr", "F_duplicates_and_garbage/hidden_folder/multi",
    ]);
    // inventory row 12 is an upper bound: the non-inheriting folder and the folder below it do not widen
    expect(widenedFolders.some((w) => /no_inherit/.test(w))).toBe(false);
    // A's private set and F's hidden set (the same listed roles); C's (no role) and J's (not written) do not move
    expect(widenedSets.sort()).toEqual([
      "A_null_hr_write_engineer_owned/private_set/engineer", "A_null_hr_write_engineer_owned/private_set/hr", "A_null_hr_write_engineer_owned/private_set/multi",
      "F_duplicates_and_garbage/hidden_set/engineer", "F_duplicates_and_garbage/hidden_set/hr", "F_duplicates_and_garbage/hidden_set/multi",
    ]);
  });

  it("the expected people: listed roles (headline or additive), controllers and the owner read; a member the lists leave out does not, unless a deeper grant names them", () => {
    const reads = (lib: string, doc: string) => memberKeys.filter((who) => appAnswers(after[lib], LIBS.find((l) => l.key === lib)!, who)[doc]);
    expect(reads("A_null_hr_write_engineer_owned", "private")).toEqual(["admin", "addCtrl", "hr", "engineer", "owner", "multi"]);
    expect(reads("A_null_hr_write_engineer_owned", "private_user_grant_vendor")).toEqual(["admin", "addCtrl", "hr", "engineer", "vendor", "owner", "multi"]);
    expect(reads("B_zero_rule_hr_visible_supervisor", "normal")).toEqual(["admin", "addCtrl", "hr", "supervisor", "multi"]);
    expect(reads("C_no_role", "normal")).toEqual(["admin", "addCtrl"]);
    expect(reads("D_no_role_hidden", "normal")).toEqual(["admin", "addCtrl"]);
    expect(reads("L_deeper_folder_grant", "private_in_vendor_folder")).toEqual(["admin", "addCtrl", "hr", "vendor", "multi"]);
    // The Everyone case is open to every member, before and after.
    expect(reads("G_all", "normal")).toEqual([...memberKeys]);
    expect(reads("I_wizard_everyone", "private")).toEqual([...memberKeys]);
    // The library page's "you don't have access": the same set as its content.
    const sees = (lib: string) => memberKeys.filter((who) => appAnswers(after[lib], LIBS.find((l) => l.key === lib)!, who).library);
    expect(sees("A_null_hr_write_engineer_owned")).toEqual(["admin", "addCtrl", "hr", "engineer", "owner", "multi"]);
    expect(sees("C_no_role")).toEqual(["admin", "addCtrl"]);
  });

  it("the wizard's Everyone grant (an org-subject allow) is untouched by the paste; the database's org bucket on a private row is intelligence I-30's (DEC-90 R5), not this file's", () => {
    const lib = LIBS.find((l) => l.key === "I_wizard_everyone")!;
    expect(after[lib.key].acl).toEqual(before[lib.key].acl);
    for (const who of memberKeys) {
      expect(appAnswers(after[lib.key], lib, who)).toEqual(appAnswers(before[lib.key], lib, who));
    }
    // Pinned as found, unchanged by the paste: node_visible's allow branch has
    // no org bucket, so the database returns the Everyone library's PRIVATE
    // row to controllers only while the app's doors let every member read it.
    // intelligence I-30 adds the bucket (DEC-90 R5); flip this then.
    const dbReaders = memberKeys.filter((who) => dbDocAnswers(lib, who).private);
    expect(dbReaders).toEqual(["admin", "addCtrl"]);
  });

  it("idempotent: a re-paste writes nothing, every probe stays true, and no row changes", () => {
    const snapshot = admin(scratch, "SELECT md5(string_agg(row_to_json(l)::text, ',' ORDER BY id)) FROM libraries l");
    second = paste(scratch);
    expect(second.error).toBeNull();
    for (const p of second.rows.filter((r) => r.ok === "t" || r.ok === "f")) {
      // The "wrote every library the inventory counted" probe is 0 = 0 on a re-paste.
      expect(p.ok, p.check).toBe("t");
    }
    expect(inv(second, "before: libraries this paste writes")).toBe("0");
    expect(inv(second, "this paste: libraries written")).toBe("0");
    expect(inv(second, "after: libraries whose ACL is exactly the rung their lists stand for")).toBe("7");
    expect(admin(scratch, "SELECT md5(string_agg(row_to_json(l)::text, ',' ORDER BY id)) FROM libraries l")).toBe(snapshot);
  });
});
