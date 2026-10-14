// intelligence Round G, package I-12 DOCUMENT ACL BOUNDARY — the second
// review's fixes that are pure (no service-role stand-in):
//
//   DACL-10 / GAP-15 (DEC-7)  the library page reads the library's OWNER and
//            visibility with the row (lib/libraryAccess LIBRARY_PAGE_COLUMNS
//            / libraryConfigFromRow). It never did, so the owner
//            short-circuit was always false — and once a legacy read list
//            synthesizes a restricted rung, a non-controller owner of a
//            legacy-restricted library lost its contents and saw "You don't
//            have access to this library" (on base they listed; the AI seam
//            and the bytes door still served them).
//   DACL-10 (malformed list)  a read_access that is neither "ALL" nor an
//            array restricts at the server as on both pages — it read as "no
//            rung" (open at the AI seam and the bytes door).
//   VFY-7 done-when 3  both short-link reads always run: a search that finds
//            ONE exact normalized match no longer hides a second one.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveLibraryAcl, effectiveLibraryAclFromRow, explorerDocReadable, explorerFolderVisible, explorerLibraryVisible,
  libraryConfigFromRow, libraryReadsByRole, LIBRARY_PAGE_COLUMNS,
} from "@/lib/libraryAccess";
import { shortLinkExactMatches, normalizedNumberPattern } from "@/lib/docNumberMatch";
import type { Principal } from "@/lib/permissions";
import type { Role } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ORG = "o1";
const SUP = "u-supervisor";

/** A legacy library row as select(LIBRARY_PAGE_COLUMNS) returns it: read
 *  list ['HR'], ACL empty, owned by a Supervisor who is not HR. */
const legacyRow = (over: Record<string, unknown> = {}) => ({
  id: "lib-1", org_id: ORG, name: "HR records", type: "document", description: null,
  custom_columns: [], column_label_overrides: {}, uniqueness_keys: null,
  write_access: [], admin_access: [], read_access: ["HR"], visible_to: [],
  folder_security: "Inherited", default_new_visibility: "normal", default_new_acl: null,
  acl: { inherit: true, visibility: "normal", rules: [] }, acl_index: null,
  column_widths: {}, color: null, icon: null, cover_image_url: null, cover_tint: null, home_config: null, page_config: null,
  owner_user_id: SUP, visibility: "normal",
  ...over,
});
const supervisor: Principal = { uid: SUP, role: "Supervisor" as Role, roles: ["Supervisor"] as Role[], orgId: ORG, teamIds: [], isActiveMember: true };
const stranger: Principal = { uid: "u-other", role: "Supervisor" as Role, roles: ["Supervisor"] as Role[], orgId: ORG, teamIds: [], isActiveMember: true };

/** The library page's two explorer filters, exactly as it calls them: the
 *  owner cascade ends in the library's owner (page: `?? library?.ownerUserId
 *  ?? null`). */
function pageSees(p: Principal, row: Record<string, unknown>) {
  const library = libraryConfigFromRow(row);
  const rung = effectiveLibraryAcl(library);
  const folder = { id: "f1", pathIds: [], acl: undefined, visibility: "normal" as const, ownerUserId: null };
  const folderMap = new Map([["f1", folder]]);
  const doc = { collectionId: "f1", acl: undefined, ownerUserId: null };
  const isController = (p.roles ?? []).some((r) => r === "Admin" || r === "DocCtrl");
  const isLibraryOwner = !!p.uid && !!library.ownerUserId && library.ownerUserId === p.uid;
  return {
    libraryReadable: isController || isLibraryOwner || explorerLibraryVisible(p, library),
    folder: explorerFolderVisible(p, rung, folder, folderMap, folder.ownerUserId ?? library.ownerUserId ?? null),
    doc: explorerDocReadable(p, rung, doc, folderMap, doc.ownerUserId ?? library.ownerUserId ?? null),
  };
}

describe("DACL-10 / GAP-15 (second review fix) — the owner of a legacy-restricted library sees its contents on the library page", () => {
  it("reproduction → fix: read_access ['HR'], ACL empty, owner a non-HR Supervisor — the owner sees the folder and the document, and no 'no access' state; a non-owner Supervisor still does not", () => {
    expect(pageSees(supervisor, legacyRow())).toEqual({ libraryReadable: true, folder: true, doc: true });
    expect(pageSees(stranger, legacyRow())).toEqual({ libraryReadable: false, folder: false, doc: false });
    // the reproduction: the page's mapping as it was (no owner carried)
    const { owner_user_id: _o, ...withoutOwner } = legacyRow();
    void _o;
    expect(pageSees(supervisor, withoutOwner)).toEqual({ libraryReadable: false, folder: false, doc: false });
  });
  it("the page reads owner_user_id and visibility with the row, and maps them (the select('*') fallback carries them too)", () => {
    expect(LIBRARY_PAGE_COLUMNS.split(",")).toEqual(expect.arrayContaining(["owner_user_id", "visibility", "read_access", "visible_to", "write_access", "admin_access", "acl"]));
    const cfg = libraryConfigFromRow(legacyRow({ visibility: "private" }));
    expect(cfg.ownerUserId).toBe(SUP);
    expect(cfg.visibility).toBe("private");
    expect(cfg.readAccess).toEqual(["HR"]);
    // a database without either column: no owner, visibility unset (as before)
    const { owner_user_id: _a, visibility: _b, ...old } = legacyRow();
    void _a; void _b;
    expect(libraryConfigFromRow(old)).toMatchObject({ ownerUserId: null, visibility: undefined, readAccess: ["HR"] });
    // NULL read list reads "ALL", as the page always did
    expect(libraryConfigFromRow(legacyRow({ read_access: null })).readAccess).toBe("ALL");
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/\.select\(LIBRARY_PAGE_COLUMNS\)/);
    expect(page).toMatch(/const fresh: LibraryConfig = libraryConfigFromRow\(data\);/);
    expect(page).not.toMatch(/const LIB_COLS =/);
    expect(page).toMatch(/const isLibraryOwner = !!uid && !!library\?\.ownerUserId && library\.ownerUserId === uid;/);
    expect(page).toMatch(/const libraryReadable = isController \|\| isLibraryOwner \|\| explorerLibraryVisible\(principal, library\);/);
  });
  it("the library Permissions drawer keeps opening on the ACL's visibility — the column, now read, never overrides it (a save would rewrite the ACL from the column)", () => {
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    const drawer = page.slice(page.indexOf('nodeType="library"'), page.indexOf('nodeType="library"') + 900);
    expect(drawer).toMatch(/visibility=\{library\.acl\?\.visibility\}/);
    expect(drawer).not.toMatch(/visibility=\{library\.visibility/);
  });
});

describe("DACL-10 (second review fix) — a malformed read_access restricts at the server as on both pages", () => {
  it("a JSON string other than 'ALL', an object or a number stands for a restricted list naming no role (a private rung with no grant); 'ALL', NULL and arrays are unchanged", () => {
    for (const ra of ["Engineering", { roles: ["HR"] }, 7, "all"]) {
      const rung = effectiveLibraryAclFromRow({ acl: null, read_access: ra });
      expect(rung, JSON.stringify(ra)).toBeDefined();
      expect(rung!.visibility, JSON.stringify(ra)).toBe("private");
      expect(rung!.rules, JSON.stringify(ra)).toEqual([]);
      // both pages hide it too
      expect(libraryReadsByRole({ readAccess: ra as never, visibleTo: [] }, "Viewer" as Role)).toBe(false);
    }
    // a write role still reads, as the wizard grants
    const withWrite = effectiveLibraryAclFromRow({ acl: null, read_access: "Engineering", write_access: ["Drafter"] });
    expect(withWrite!.rules.map((r) => (r.subject as { id: string }).id)).toEqual(["Drafter"]);
    expect(effectiveLibraryAclFromRow({ acl: null, read_access: "ALL" })).toBeUndefined();
    expect(effectiveLibraryAclFromRow({ acl: null, read_access: null })).toBeUndefined();
    expect(effectiveLibraryAclFromRow({ acl: null, read_access: ["HR"] })!.rules).toHaveLength(1);
    // the server's reading and the library page's agree for a malformed list
    const page = libraryConfigFromRow(legacyRow({ read_access: "Engineering", owner_user_id: null }));
    expect(explorerLibraryVisible(stranger, page)).toBe(false);
  });
});

describe("VFY-7 done-when 3 (second review fix) — both short-link reads always run; a second exact normalized match is never hidden", () => {
  type R = { id: string; document_number: string | null };
  const P101 = { id: "d1", document_number: "P-101" };
  const P101b = { id: "d2", document_number: "P101" };
  const P1011 = { id: "d3", document_number: "P-1011" };
  it("reproduction → fix: the search returns ONE exact match ('P-101'); the normalized read finds 'P101' too — two matches (the chooser), never the silent pick", async () => {
    const calls: string[] = [];
    const hits = await shortLinkExactMatches<R>("P-101", {
      search: async (q) => { calls.push(`search:${q}`); return [P101, P1011]; },
      normalized: async (pattern) => { calls.push(`normalized:${pattern}`); return [P101, P101b]; },
    });
    expect(hits.map((h) => h.id).sort()).toEqual(["d1", "d2"]);
    expect(calls).toEqual(["search:P-101", `normalized:${normalizedNumberPattern("p101")}`]);
  });
  it("one exact match from both reads deep-links (one row); none falls back; only exact normalized numbers are taken", async () => {
    expect(await shortLinkExactMatches<R>("p 101", { search: async () => [P101], normalized: async () => [P101] })).toEqual([P101]);
    expect(await shortLinkExactMatches<R>("P-101", { search: async () => [P1011], normalized: async () => [] })).toEqual([]);
  });
  it("a number too short to normalize usefully asks the search alone; a failed read throws — the caller cannot tell one match from two, so it never deep-links", async () => {
    let normalizedCalled = false;
    expect(await shortLinkExactMatches<R>("7", { search: async () => [{ id: "x", document_number: "7" }], normalized: async () => { normalizedCalled = true; return []; } }))
      .toEqual([{ id: "x", document_number: "7" }]);
    expect(normalizedCalled).toBe(false);
    await expect(shortLinkExactMatches<R>("P-101", { search: async () => [P101], normalized: async () => { throw new Error("statement timeout"); } }))
      .rejects.toThrow("statement timeout");
    // the page: a throw empties the hits (search fallback), never a deep link
    const home = src("app/(protected)/documents/page.tsx");
    expect(home).toMatch(/\} catch \{ hits = \[\]; \/\* one match cannot be told from two — fall through to search \*\/ \}/);
  });
});
