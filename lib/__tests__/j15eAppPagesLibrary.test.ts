// projects-joint J15e APP AND COMPONENT WRITE SWEEP, batch J15e-app
// (projects-tab SAF-22) — the library page's own writes
// (app/(protected)/documents/[libraryId]/page.tsx).
//
// Several of them discarded the write's answer altogether — a column, a
// uniqueness rule or a folder index that row-level security refused (zero
// rows, no error) or that failed was shown as saved. Each handler is lifted
// from the page source and run (the shape dcRoundGP28IntegratorFixPass uses
// for the bulk archive) against lib/__tests__/helpers/fakeSupabase.ts; a
// table in `refuseWrites` is the zero-row answer. The two inline JSX saves
// (the home board, the equipment pill cell) are pinned by source, beside the
// components that await them (LibraryHomeBoard catches; PillCell does not, so
// the page never throws there).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";
import { checkedWrite, CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { answered, keptAnswer } from "@/lib/checkedWriteAnswer";
import { notLandedReason, NOT_MATCHED_REASON } from "@/lib/checkedWriteReason";
import { translatePostgresError } from "@/lib/inputValidation";

const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");

/** The handler `name`, lifted from the page and closed over `deps`. */
function lift<T>(name: string, deps: Record<string, unknown>): T {
  const start = page.indexOf(`\n  const ${name} = async (`);
  expect(start, name).toBeGreaterThan(0);
  const end = page.indexOf("\n  };\n", start) + "\n  };\n".length;
  const code = page.slice(start, end);
  const names = Object.keys(deps);
  const js = ts.transpileModule(`function factory({ ${names.join(", ")} }) {${code}\nreturn ${name};\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return (new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => T)(deps);
}

let db: FakeDb;
let ui: { errors: Array<string | null>; library: Row | null; libSets: number; updateColumns: unknown[][]; alerts: Array<Record<string, unknown>>; docNumErr: Array<string | null>; documents: Row[] };
const LIBRARY = { id: "l1", customColumns: [{ key: "a", label: "A", type: "text" }], uniquenessKeys: ["documentNumber"], columnLabelOverrides: {} };

function deps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supabase: makeFakeSupabase(db), checkedWrite, answered, keptAnswer, notLandedReason, CHECKED_WRITE_REFUSED, translatePostgresError,
    library: LIBRARY, activeOrgId: "o1", uid: "u1", activeColumns: ["title"],
    setLibrary: (f: (p: Row) => Row) => { ui.libSets++; ui.library = f(ui.library ?? { ...LIBRARY }); },
    updateColumns: async (...a: unknown[]) => { ui.updateColumns.push(a); },
    setError: (m: string | null) => { ui.errors.push(m); },
    appAlert: async (o: Record<string, unknown>) => { ui.alerts.push(o); },
    ...extra,
  };
}

beforeEach(() => {
  db = newFakeDb();
  db.tables.libraries = [{ id: "l1", custom_columns: LIBRARY.customColumns, uniqueness_keys: ["documentNumber"] }];
  ui = { errors: [], library: null, libSets: 0, updateColumns: [], alerts: [], docNumErr: [], documents: [] };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the column and uniqueness writes (class a) — discarded before, now said", () => {
  const field = { key: "sheet2", label: "Sheet 2", type: "text" };
  it("handleSaveColumn: ordinary path writes, updates the page and the view as before", async () => {
    await lift<(f: unknown) => Promise<void>>("handleSaveColumn", deps())(field);
    expect((db.tables.libraries[0].custom_columns as Row[]).map((c) => c.key)).toEqual(["a", "sheet2"]);
    expect(ui.libSets).toBe(1);
    expect(ui.updateColumns).toEqual([[["title", "sheet2"], { scope: "org" }]]);
    expect(ui.errors).toEqual([]);
  });
  it("REPRODUCED: a column write row-level security refused showed the column as made; now it is said, and neither the page nor the view changes", async () => {
    db.refuseWrites.add("libraries");
    await lift<(f: unknown) => Promise<void>>("handleSaveColumn", deps())(field);
    expect(ui.libSets).toBe(0);
    expect(ui.updateColumns).toEqual([]);
    expect(ui.errors).toEqual(["Failed to create column."]);
  });
  it("handleSaveUniquenessKeys: a refused write is said in plain words, the rule on screen unchanged", async () => {
    db.refuseWrites.add("libraries");
    await lift<(n: string[]) => Promise<void>>("handleSaveUniquenessKeys", deps())(["documentNumber", "sheet"]);
    expect(ui.libSets).toBe(0);
    expect(ui.errors).toEqual([`Couldn't save library — ${CHECKED_WRITE_REFUSED}`]);
  });
  it("handleSaveUniquenessKeys: ordinary path as before", async () => {
    await lift<(n: string[]) => Promise<void>>("handleSaveUniquenessKeys", deps())(["documentNumber", "sheet"]);
    expect(db.tables.libraries[0].uniqueness_keys).toEqual(["documentNumber", "sheet"]);
    expect(ui.library!.uniquenessKeys).toEqual(["documentNumber", "sheet"]);
    expect(ui.errors).toEqual([]);
  });
  it("handleAddSheetAndUseForUniqueness: when the column lands and the rule is refused, the column stays on screen and the message says the column was added (never 'nothing changed')", async () => {
    let n = 0;
    db.beforeUpdate!.libraries = (next) => { if (++n === 2) throw { message: "permission denied for table libraries", code: "42501" }; return next; };
    await lift<() => Promise<void>>("handleAddSheetAndUseForUniqueness", deps())();
    expect((ui.library!.customColumns as Row[]).map((c) => c.key)).toEqual(["a", "sheet"]);
    expect(ui.library!.uniquenessKeys).toEqual(["documentNumber"]);
    expect(ui.errors).toEqual(["Couldn't save library — The Sheet column was added, but it was not made part of the uniqueness rule: You don't have permission to do this."]);
    expect(ui.errors[0]).not.toMatch(/nothing was changed/i);
    expect(ui.updateColumns).toEqual([]);
  });
  it("handleAddSheetAndUseForUniqueness: ordinary path writes both and adds the view column, as before", async () => {
    await lift<() => Promise<void>>("handleAddSheetAndUseForUniqueness", deps())();
    expect(db.tables.libraries[0].uniqueness_keys).toEqual(["documentNumber", "sheet"]);
    expect(ui.updateColumns).toEqual([[["title", "sheet"], { scope: "org" }]]);
    expect(ui.errors).toEqual([]);
  });
});

describe("the column manager's delete and rename (class a)", () => {
  it("delete: a refused write is said over the manager (appAlert) and answered false (the manager keeps the column in its view, R2) — never thrown", async () => {
    db.refuseWrites.add("libraries");
    await expect(lift<(k: string) => Promise<boolean>>("handleDeleteColumn", deps())("a")).resolves.toBe(false);
    expect(ui.alerts).toEqual([{ message: `The column was not deleted: ${CHECKED_WRITE_REFUSED}`, tone: "danger" }]);
    expect(ui.libSets).toBe(0);
    expect(ui.updateColumns).toEqual([]);
  });
  it("delete: ordinary path as before (answered true)", async () => {
    await expect(lift<(k: string) => Promise<boolean>>("handleDeleteColumn", deps())("a")).resolves.toBe(true);
    expect(db.tables.libraries[0].custom_columns).toEqual([]);
    expect(ui.updateColumns).toEqual([[["title"], { scope: "org" }]]);
  });
  it("rename: a refused write throws the typed refusal; a database error keeps its own words (the manager's migration hint reads them)", async () => {
    db.refuseWrites.add("libraries");
    await expect(lift<(k: string, l: string) => Promise<void>>("handleRenameColumn", deps())("a", "Alpha")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await expect(lift<(k: string, l: string) => Promise<void>>("handleRenameColumn", deps())("title", "Name")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    db = newFakeDb();
    db.tables.libraries = [{ id: "l1" }];
    db.beforeUpdate!.libraries = () => { throw { code: "PGRST204", message: "Could not find the 'column_label_overrides' column of 'libraries' in the schema cache" }; };
    await expect(lift<(k: string, l: string) => Promise<void>>("handleRenameColumn", deps())("title", "Name")).rejects.toThrow("Could not find the 'column_label_overrides' column of 'libraries' in the schema cache");
    expect(ui.libSets).toBe(0);
  });
  it("rename: ordinary path as before", async () => {
    await lift<(k: string, l: string) => Promise<void>>("handleRenameColumn", deps())("title", "Name");
    expect(db.tables.libraries[0].column_label_overrides).toEqual({ title: "Name" });
    expect(ui.libSets).toBe(1);
  });
});

describe("a document's title and number (class a)", () => {
  const titleDeps = () => deps({
    setSavingTitle: () => {}, setEditingTitleId: () => {}, setEditingTitleValue: () => {},
    setDocuments: (f: (p: Row[]) => Row[]) => { ui.documents = f(ui.documents); },
  });
  it("title: a rename that matched no row is said as the typed refusal; the list keeps the old title", async () => {
    db.tables.documents = [{ id: "d1", title: "Old" }];
    ui.documents = [{ id: "d1", title: "Old" }];
    db.refuseWrites.add("documents");
    await lift<(id: string, v: string) => Promise<void>>("saveInlineTitle", titleDeps())("d1", "New");
    expect(ui.errors).toEqual([CHECKED_WRITE_REFUSED]);
    expect(ui.documents[0].title).toBe("Old");
  });
  it("title: ordinary path as before", async () => {
    db.tables.documents = [{ id: "d1", title: "Old" }];
    ui.documents = [{ id: "d1", title: "Old" }];
    await lift<(id: string, v: string) => Promise<void>>("saveInlineTitle", titleDeps())("d1", "New");
    expect(db.tables.documents[0].title).toBe("New");
    expect(ui.documents[0].title).toBe("New");
    expect(ui.errors).toEqual([]);
  });
  const numDeps = () => deps({
    documents: [{ id: "d1", documentNumber: "P-1", title: "T", rev: "A", status: "Issued", metadata: {} }],
    computeUniquenessKey: () => "P-2", setSavingDocNum: () => {},
    setEditingDocNumError: (m: string | null) => { ui.docNumErr.push(m); },
    setEditingDocNumId: () => {}, setEditingDocNumValue: () => {},
    setDocuments: (f: (p: Row[]) => Row[]) => { ui.documents = f(ui.documents); },
    requestUnitCodeDecode: async () => ({}),
  });
  it("number: a renumber that matched no row is said where a database error is said; the cell keeps the old number", async () => {
    db.tables.documents = [{ id: "d1", document_number: "P-1" }];
    ui.documents = [{ id: "d1", documentNumber: "P-1" }];
    db.refuseWrites.add("documents");
    await lift<(id: string, v: string) => Promise<void>>("saveInlineDocNumber", numDeps())("d1", "P-2");
    expect(ui.docNumErr.at(-1)).toBe(CHECKED_WRITE_REFUSED);
    expect(ui.documents[0].documentNumber).toBe("P-1");
  });
  it("number: ordinary path as before", async () => {
    db.tables.documents = [{ id: "d1", document_number: "P-1" }];
    ui.documents = [{ id: "d1", documentNumber: "P-1" }];
    await lift<(id: string, v: string) => Promise<void>>("saveInlineDocNumber", numDeps())("d1", "P-2");
    expect(db.tables.documents[0].document_number).toBe("P-2");
    expect(ui.documents[0].documentNumber).toBe("P-2");
  });
});

describe("a new folder's permissions index", () => {
  const folderDeps = () => deps({
    library: { ...LIBRARY, folderSecurity: "Granular", defaultNewVisibility: "normal" },
    renameValue: "Specs", libraryId: "l1", currentFolderId: null, currentFolder: null,
    createFolder: async () => { db.tables.collections = [{ id: "f-new" }]; return "f-new"; },
    buildFolderChain: () => [], buildAclIndexFromChain: () => ({ v: 1 }),
    setCreatingFolder: () => {}, setRenameValue: () => {},
  });
  it("the folder exists either way: an index write that matched no row is said (it was discarded), never 'Failed to create folder'", async () => {
    db.refuseWrites.add("collections");
    await lift<() => Promise<void>>("confirmCreateFolder", folderDeps())();
    expect(ui.errors).toEqual([`The folder "Specs" was created, but its permissions could not be applied: ${NOT_MATCHED_REASON}`]);
    expect(ui.errors[0]).not.toMatch(/nothing was changed/i);
  });
  it("ordinary path: the index lands, nothing said", async () => {
    await lift<() => Promise<void>>("confirmCreateFolder", folderDeps())();
    expect(db.tables.collections[0].acl_index).toEqual({ v: 1 });
    expect(ui.errors).toEqual([]);
  });
});

describe("the two inline saves, pinned by source", () => {
  it("the home board's save throws on a refused or failed write (LibraryHomeBoard catches it and keeps the editor open)", () => {
    expect(page).toMatch(/const saved = await checkedWrite\(supabase\.from\("libraries"\)\.update\(\{ home_config: cfg, updated_by: uid \}\)\.eq\("id", library\.id!\)\.select\("id"\)\);\s*\n\s*if \(!saved\.ok\) throw new Error\(`The home could not be saved: \$\{saved\.error\}`\);\s*\n\s*setLibrary/);
    const board = readFileSync(join(process.cwd(), "components/documents/LibraryHomeBoard.tsx"), "utf8");
    expect(board).toMatch(/try \{ await onSave\(\{ \.\.\.draft, enabled: true \}\); setEditing\(false\); \}\s*\n\s*catch \(e\) \{ await saveFailed\(e\); \}/);
  });
  it("the equipment pill cell's save puts the cell back and says it on a refused or failed write — never thrown (PillCell awaits without a catch)", () => {
    expect(page).toMatch(/const saved = await checkedWrite\(supabase\.from\("documents"\)\.update\(\{\s*metadata: newMeta,\s*updated_at: new Date\(\)\.toISOString\(\),\s*\}\)\.eq\("id", docRecord\.id\)\.select\("id"\)\);\s*\n\s*if \(!saved\.ok\) \{\s*\n\s*setDocuments\(\(prev\) => prev\.map\(\(d\) =>\s*\n\s*d\.id === docRecord\.id \? \{ \.\.\.d, metadata: docRecord\.metadata \} : d\s*\n\s*\)\);\s*\n\s*setError\(/);
    const pill = readFileSync(join(process.cwd(), "components/documents/PillCell.tsx"), "utf8");
    expect(pill).toMatch(/try \{\s*\n\s*await onSave\(pills\);\s*\n\s*\} finally \{/);
  });
  it("ruling R1: the two never-sent column-width saves are gone (nothing was ever written by them); the page still reads and live-syncs the stored widths (REV-38)", () => {
    expect(page).not.toMatch(/update\(\{ column_widths/);
    expect(page).not.toMatch(/saveWidthsTimerRef|colWidthsRef/);
    expect(page).toMatch(/const widths = data\.column_widths \?\? \{\};\s*\n\s*setColWidths\(widths\);/);
    // document-control REV-38 (F6-column-widths) since: the live-sync takes
    // the row's widths through the width saver (never during the drag, a
    // waiting / in-flight save, or the person's own echo) — pinned in
    // dcRev38ColumnWidths.test.ts; the page's one width write is the checked
    // saveLibraryColumnWidths (lib/libraryColumnWidths.ts), not an inline one.
    expect(page).toMatch(/\?\.column_widths;\s*\n[\s\S]{0,400}acceptRemote\(next, resizing\)[\s\S]{0,40}\n\s*if \(take\) setColWidths\(next\);/);
  });
});

// ── the admin libraries page's edit, and the library card's appearance ──
function liftFrom<T>(file: string, name: string, deps: Record<string, unknown>): T {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  const start = src.indexOf(`\n  const ${name} = async (`);
  expect(start, name).toBeGreaterThan(0);
  const end = src.indexOf("\n  };\n", start) + "\n  };\n".length;
  const names = Object.keys(deps);
  const js = ts.transpileModule(`function factory({ ${names.join(", ")} }) {${src.slice(start, end)}\nreturn ${name};\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return (new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => T)(deps);
}

describe("admin libraries page — an edit that matched no row (class a)", () => {
  const run = async () => {
    const owners: unknown[] = [];
    let libs: Row[] = [{ id: "l1", name: "Specs" }];
    const fn = liftFrom<(c: Row) => Promise<void>>("app/(protected)/admin/libraries/page.tsx", "handleSaveLibrary", {
      activeOrgId: "o1", uid: "u1", libraries: libs, editingLib: { id: "l1", name: "Specs", ownerUserId: null, acl: null },
      supabase: makeFakeSupabase(db), checkedWrite, answered, keptAnswer, CHECKED_WRITE_REFUSED,
      appAlert: async (o: Record<string, unknown>) => { ui.alerts.push(o); },
      setSaving: () => {}, setIsModalOpen: () => {}, setEditingLib: () => {},
      setLibraries: (f: (p: Row[]) => Row[]) => { libs = f(libs); ui.libSets++; },
      mergeWizardLibraryAcl: () => null, buildAclIndex: () => null, wizardListColumnsFromAcl: () => ({ write_access: [], admin_access: [] }),
      assignLibraryOwner: async (o: unknown) => { owners.push(o); },
    });
    await fn({ name: "Specs", type: "Engineering", ownerUserId: "u9" });
    return { owners };
  };
  it("ordinary path: the edit lands, the owner is assigned, the list updated, as before", async () => {
    const { owners } = await run();
    expect(db.tables.libraries[0].name).toBe("Specs");
    expect(owners).toHaveLength(1);
    expect(ui.libSets).toBe(1);
    expect(ui.alerts).toEqual([]);
  });
  it("REPRODUCED: an edit row-level security filtered to zero rows was shown as saved; now the typed refusal is shown, and no owner write or cached edit follows", async () => {
    db.refuseWrites.add("libraries");
    const { owners } = await run();
    expect(owners).toEqual([]);
    expect(ui.libSets).toBe(0);
    expect(ui.alerts).toEqual([{ message: `Error saving library: ${CHECKED_WRITE_REFUSED}`, tone: "danger" }]);
  });
});

describe("library card appearance (documents index) — class a", () => {
  const run = () => {
    let libs: Row[] = [{ _id: "l1", color: null }];
    const fn = liftFrom<(id: string, v: Row) => Promise<void>>("app/(protected)/documents/page.tsx", "saveLibraryAppearance", {
      libraries: libs, supabase: makeFakeSupabase(db), checkedWrite, answered, keptAnswer, CHECKED_WRITE_REFUSED,
      appAlert: async (o: Record<string, unknown>) => { ui.alerts.push(o); },
      setLibraries: (f: (p: Row[]) => Row[]) => { libs = f(libs); ui.libSets++; },
    });
    return fn("l1", { color: "#123456", bgType: "none" });
  };
  it("ordinary path as before", async () => {
    await run();
    expect(db.tables.libraries[0].color).toBe("#123456");
    expect(ui.libSets).toBe(1);
    expect(ui.alerts).toEqual([]);
  });
  it("a save that matched no row is said like an error and the card is not changed", async () => {
    db.refuseWrites.add("libraries");
    await run();
    expect(ui.libSets).toBe(0);
    expect(ui.alerts).toEqual([{ message: `Save failed: ${CHECKED_WRITE_REFUSED}`, tone: "danger" }]);
  });
  it("a database error keeps its own words, as before", async () => {
    db.beforeUpdate!.libraries = () => { throw { message: "value too long for type character varying(7)", code: "22001" }; };
    await run();
    expect(ui.alerts).toEqual([{ message: "Save failed: value too long for type character varying(7)", tone: "danger" }]);
  });
});

describe("team page — a member's roles (the same reads, through checkedWrite)", () => {
  const run = async () => {
    const audits: unknown[] = [];
    let members: Row[] = [{ id: "m1", uid: "u2", email: "p@x.io", role: "Viewer", roles: ["Viewer"] }];
    const fn = liftFrom<(m: Row, r: string[]) => Promise<void>>("app/(protected)/admin/users/page.tsx", "persistRoles", {
      appAlert: async (o: unknown) => { ui.alerts.push(typeof o === "string" ? { message: o } : o as Record<string, unknown>); },
      appConfirm: async () => true, rolesOf: (m: Row) => m.roles, primaryRole: (r: string[]) => r[0],
      setSavingRoleId: () => {}, members, setMembers: (f: unknown) => { if (typeof f === "function") members = (f as (p: Row[]) => Row[])(members); else members = f as Row[]; },
      supabase: makeFakeSupabase(db), checkedWrite, answered, keptAnswer, ROLE_WRITE_REFUSED: "ROLE_WRITE_REFUSED",
      uid: "u1", activeOrgId: "o1", userEmailForAudit: "a@x", activeRole: "Admin",
      logAuditAction: async (e: unknown) => { audits.push(e); return { ok: true }; },
    });
    await fn(members[0], ["Engineer-1", "Viewer"]);
    return { audits, members };
  };
  it("ordinary path: saved and audited, as before", async () => {
    db.tables.org_members = [{ id: "m1", role: "Viewer", roles: ["Viewer"] }];
    const { audits } = await run();
    expect(db.tables.org_members[0].roles).toEqual(["Engineer-1", "Viewer"]);
    expect(audits).toHaveLength(1);
    expect(ui.alerts).toEqual([]);
  });
  it("a write that matched no row is the refusal it was (ROLE_WRITE_REFUSED), reverted, no audit row", async () => {
    db.tables.org_members = [{ id: "m1", role: "Viewer", roles: ["Viewer"] }];
    db.refuseWrites.add("org_members");
    const { audits, members } = await run();
    expect(audits).toEqual([]);
    expect(members[0].roles).toEqual(["Viewer"]);
    expect(ui.alerts).toEqual([{ message: "Couldn't update roles: ROLE_WRITE_REFUSED", tone: "danger" }]);
  });
  it("before the roles column exists the headline alone is saved, as before; its own zero-row match is refused the same way", async () => {
    db.tables.org_members = [{ id: "m1", role: "Viewer" }];
    let n = 0;
    db.beforeUpdate!.org_members = (next) => { if (++n === 1) throw { code: "PGRST204", message: "Could not find the 'roles' column of 'org_members' in the schema cache" }; return next; };
    await run();
    expect(db.tables.org_members[0].role).toBe("Engineer-1");
    expect(ui.alerts[0].message ?? ui.alerts[0]).toMatch(/Saved the primary role/);
  });
});

describe("the answer thumbs (knowledge page) — a rating the server did not keep is not shown as saved", () => {
  it("the caller of /api/knowledge/feedback puts the thumbs back when the rating fails (the route now refuses a zero-row match, 409)", () => {
    const src = readFileSync(join(process.cwd(), "app/(protected)/knowledge/[id]/page.tsx"), "utf8");
    const rate = src.slice(src.indexOf("  const rate = async (r: 1 | -1) => {"), src.indexOf("  const btn = (active: boolean) =>"));
    expect(rate).toMatch(/const next = state === r \? 0 : r;[\s\S]*setState\(next\);[\s\S]*await rateKnowledgeAnswer\(questionId, next\);[\s\S]*\} catch \{[\s\S]*setState\(state\);\s*\n\s*\}/);
  });
});
