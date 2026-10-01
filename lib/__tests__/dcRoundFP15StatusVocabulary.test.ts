// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS: public-surfaces
// VFY-20 under DEC-44 (P15) (awaiting the user's ratification). The editors
// stop offering "IFC" for a new choice; existing IFC rows are not migrated
// and are shown as what they are; the print gate, the verify allow-list and
// what the database calls an issue are unchanged.
//
// THE pin (done-when 2): every status any editor offers is either in force
// at BOTH the print gate (lib/docPack.ts filterPackDocs) and the verify
// allow-list (lib/verifyVerdict.ts IN_FORCE_STATUSES), or refused by both —
// and none of them reads as STATUS NOT RECOGNISED.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown>; id: string }>,
  /** P15 review fix: the open holds lib/holdGate.ts reads, by document. */
  holds: {} as Record<string, Array<{ id: string; reason: string }>>,
  holdReads: [] as string[],
  holdReadError: null as { message: string } | null,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: unknown) => ({
          select: () => { s.calls.push({ table, payload, id: String(val) }); return Promise.resolve({ data: [{ id: String(val) }], error: null }); },
        }),
      }),
      select: () => ({
        eq: (_col: string, val: unknown) => ({
          is: () => {
            s.holdReads.push(String(val));
            return Promise.resolve(s.holdReadError
              ? { data: null, error: s.holdReadError }
              : { data: (s.holds[String(val)] ?? []).map((h) => ({ ...h, opened_at: null, opened_by_name: null })), error: null });
          },
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn() }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn() }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/AssetTagChip", () => ({ default: () => null }));
// LifecycleBoard's own panels (only its column rule is exercised here)
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({}) }));
vi.mock("@/components/documents/DocControlQueue", () => ({ default: () => null }));
vi.mock("@/components/documents/ProtectionRecord", () => ({ default: () => null }));

import {
  BULK_EDIT_STATUS_OPTIONS, METADATA_EDITOR_STATUS_OPTIONS, STAGING_STATUS_OPTIONS, RETIRED_STATUS_OPTIONS,
  statusSelectOptions, notOfferedStatusNote, isUnguardedEntryIntoForce,
} from "@/lib/documentStatusOptions";
import { filterPackDocs } from "@/lib/docPack";
import { IN_FORCE_STATUSES, isRecognisedStatus } from "@/lib/verifyVerdict";
import { isControlledIssueStatus, isIssueTransition } from "@/lib/issueStatus";
import MetadataEditor from "@/components/documents/MetadataEditor";
import BulkEditModal from "@/components/documents/BulkEditModal";
import { lifecycleOf, type BoardDoc } from "@/components/documents/LifecycleBoard";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root0 = process.cwd();
const src = (p: string) => readFileSync(join(root0, p), "utf8");
/** A status list exported from a lib file, read from its source (those libs
 *  pull the whole publish path into an import). */
function exportedList(file: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(src(file));
  expect(m, `${name} in ${file}`).not.toBeNull();
  return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/** Every status picker a person can choose a document status from. */
const EDITORS: Record<string, readonly string[]> = {
  "BulkEditModal (bulk status)": BULK_EDIT_STATUS_OPTIONS,
  "MetadataEditor (one document)": METADATA_EDITOR_STATUS_OPTIONS,
  "MetadataStagingModal (upload)": STAGING_STATUS_OPTIONS,
  "CREATION_STATUSES (new document)": exportedList("lib/revisions.ts", "CREATION_STATUSES"),
  "UNARCHIVE_RESTORE_STATUSES (un-archive)": exportedList("lib/revisions.ts", "UNARCHIVE_RESTORE_STATUSES"),
  "LEGACY_RESTORE_STATUSES (reverse a lifecycle action)": exportedList("lib/documentLifecycle/reverse.ts", "LEGACY_RESTORE_STATUSES"),
};

const printsInPack = (status: string): boolean =>
  filterPackDocs([{ id: "d1", document_number: "P-1", status }], new Set(), false).docs.length === 1;

describe("VFY-20 / DEC-44 (P15) — every editor's statuses agree with the print gate and the verify allow-list", () => {
  it("the lists each editor offers are pinned", () => {
    expect([...BULK_EDIT_STATUS_OPTIONS]).toEqual(["Draft", "In Review", "Issued", "Superseded", "Archived"]);
    expect([...METADATA_EDITOR_STATUS_OPTIONS]).toEqual(["Draft", "Issued", "Superseded", "Void", "Archived", "Locked"]);
    expect([...STAGING_STATUS_OPTIONS]).toEqual(["Draft", "In Review", "Issued", "Superseded"]);
    expect(EDITORS["CREATION_STATUSES (new document)"]).toEqual(["Draft", "Issued"]);
    expect(EDITORS["UNARCHIVE_RESTORE_STATUSES (un-archive)"]).toEqual(["Issued", "Draft", "In Review"]);
    expect(EDITORS["LEGACY_RESTORE_STATUSES (reverse a lifecycle action)"]).toEqual(["Issued", "Draft", "In Review", "Void"]);
  });
  it("THE pin: each offered status is in force at BOTH gates or refused by BOTH — and is a status the verify page recognises", () => {
    for (const [editor, list] of Object.entries(EDITORS)) {
      for (const status of list) {
        expect(printsInPack(status), `${editor}: ${status} — print gate vs verify allow-list`).toBe(IN_FORCE_STATUSES.has(status));
        expect(isRecognisedStatus(status), `${editor}: ${status} would scan STATUS NOT RECOGNISED`).toBe(true);
        expect(RETIRED_STATUS_OPTIONS.has(status), `${editor}: offers a retired status ${status}`).toBe(false);
      }
    }
  });
  it("IFC: offered by no editor; still read not-in-force by both gates (no gate changed); still an issue to the database (20261144 untouched)", () => {
    expect([...RETIRED_STATUS_OPTIONS]).toEqual(["IFC"]);
    for (const list of Object.values(EDITORS)) expect(list).not.toContain("IFC");
    expect(printsInPack("IFC")).toBe(false);
    expect(IN_FORCE_STATUSES.has("IFC")).toBe(false);
    expect(isRecognisedStatus("IFC")).toBe(false);
    expect(isControlledIssueStatus("IFC")).toBe(true);
    expect(src("supabase/migrations/20261144_dc_roundF_status_issue_transition.sql")).toMatch(/NOT IN \('Draft', 'In Review', 'Superseded', 'Void', 'Archived'\)/);
  });
  it("the editors read their lists from lib/documentStatusOptions — no inline status literal list, no IFC option anywhere in components/", () => {
    expect(src("components/documents/BulkEditModal.tsx")).toContain("const STATUS_OPTIONS = BULK_EDIT_STATUS_OPTIONS;");
    expect(src("components/documents/MetadataStagingModal.tsx")).toContain("const DEFAULT_STATUS_OPTIONS: readonly string[] = STAGING_STATUS_OPTIONS;");
    expect(src("components/documents/MetadataEditor.tsx")).toContain("statusSelectOptions(METADATA_EDITOR_STATUS_OPTIONS, document.status).map((o) => (");
    for (const f of ["components/documents/BulkEditModal.tsx", "components/documents/MetadataStagingModal.tsx", "components/documents/MetadataEditor.tsx"]) {
      expect(src(f), f).not.toMatch(/\[\s*"Draft",/);
    }
    // the only "IFC" string literals left in components/ are the lifecycle board's column (issueType-derived, not a status picker)
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root0, dir))) {
        const rel = `${dir}/${e}`;
        if (statSync(join(root0, rel)).isDirectory()) walk(rel);
        // code only: a comment may name the retired word
        else if (/\.tsx?$/.test(e) && /"IFC"/.test(src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"))) hits.push(rel);
      }
    };
    walk("components");
    expect(hits).toEqual(["components/documents/LifecycleBoard.tsx"]);
  });
});

describe("VFY-20 — an existing IFC row is shown as what it is, never silently rewritten", () => {
  it("statusSelectOptions adds the record's own value when no option offers it; notOfferedStatusNote says what the gates do with IFC", () => {
    expect(statusSelectOptions(METADATA_EDITOR_STATUS_OPTIONS, "Issued").map((o) => o.value)).toEqual([...METADATA_EDITOR_STATUS_OPTIONS]);
    expect(statusSelectOptions(METADATA_EDITOR_STATUS_OPTIONS, "IFC").at(-1)).toEqual({ value: "IFC", label: "IFC (current — not offered)", current: true });
    expect(statusSelectOptions(METADATA_EDITOR_STATUS_OPTIONS, null)).toHaveLength(METADATA_EDITOR_STATUS_OPTIONS.length);
    expect(statusSelectOptions(METADATA_EDITOR_STATUS_OPTIONS, "  ")).toHaveLength(METADATA_EDITOR_STATUS_OPTIONS.length);
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "Issued")).toBeNull();
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "")).toBeNull();
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "IFC")).toMatch(/"IFC" is no longer offered: the field pack does not print it and the verify page reads it as STATUS NOT RECOGNISED/);
    // P15 review fix: the note no longer recommends Issued — it says what choosing it does
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "IFC")).not.toMatch(/Issued is the in-force one/);
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "IFC")).toMatch(/It is kept unless you choose another; choosing Issued puts the revision in force, so do it only for a revision that was reviewed — the save checks the hold first\./);
    expect(notOfferedStatusNote(METADATA_EDITOR_STATUS_OPTIONS, "In Review")).toMatch(/"In Review" is not one of this editor's statuses; it is kept unless you choose another\./);
  });

  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { s.calls = []; s.holds = {}; s.holdReads = []; s.holdReadError = null; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const labelled = (label: string) => {
    const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
    if (!l) throw new Error(`no label "${label}"`);
    return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
  };
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === label || x.textContent?.includes(label)) as HTMLButtonElement;
  function setValue(el: HTMLSelectElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const IFC_DOC = {
    id: "d1", documentNumber: "P-101", title: "Overhead P&ID", rev: "0", status: "IFC",
    metadata: {}, libraryId: "lib", currentVersionId: "d1-v0",
  } as unknown as DocumentRecord;

  it("the metadata editor shows an IFC document as IFC (not 'Select…'), says why, and an untouched save keeps IFC", async () => {
    const onSave = vi.fn(async () => {});
    await act(async () => {
      root.render(React.createElement(MetadataEditor, {
        isOpen: true, onClose: vi.fn(), document: IFC_DOC, columns: [] as never,
        userRole: "DocCtrl", userRoles: ["DocCtrl"], onSave: onSave as never,
      }));
    });
    const sel = labelled("Status") as HTMLSelectElement;
    expect(sel.value).toBe("IFC");
    expect(sel.options[sel.selectedIndex].textContent).toBe("IFC (current — not offered)");
    expect(host.querySelector('[data-testid="status-not-offered-note"]')?.textContent).toMatch(/no longer offered/);
    await act(async () => { button("Save").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(((onSave.mock.calls[0] as unknown[])[0] as { core: { status: string } }).core.status).toBe("IFC");
  });
  it("REGRESSION: choosing a listed status replaces it and the note goes — IFC → Issued is treated as an issue: said before the save, the hold checked, then saved", async () => {
    const onSave = vi.fn(async () => {});
    await act(async () => {
      root.render(React.createElement(MetadataEditor, {
        isOpen: true, onClose: vi.fn(), document: IFC_DOC, columns: [] as never,
        userRole: "DocCtrl", userRoles: ["DocCtrl"], onSave: onSave as never,
      }));
    });
    expect(host.querySelector('[data-testid="entry-into-force-note"]')).toBeNull(); // untouched: nothing enters force
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Issued"));
    expect(host.querySelector('[data-testid="status-not-offered-note"]')).toBeNull();
    // IFC → Issued is not an issue transition to the DATABASE (IFC is already an issue there) — the REV-18 note
    // would claim a check the database does not make; the editor's own note says what it does instead
    expect(host.querySelector('[data-testid="issue-transition-note"]')).toBeNull();
    const note = host.querySelector('[data-testid="entry-into-force-note"]')!.textContent!;
    expect(note).toMatch(/^Saving puts Rev 0 in force as a controlled copy: the field pack will print it and a scan will read it as current\./);
    expect(note).toMatch(/The database does not check this change \(it already counts "IFC" as an issue\), so this editor checks the hold — the save is refused while the document is on hold\. Its review is not checked: choose Issued only for a revision that was reviewed\./);
    await act(async () => { button("Save").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.holdReads).toEqual(["d1"]);
    expect(((onSave.mock.calls[0] as unknown[])[0] as { core: { status: string } }).core.status).toBe("Issued");
  });
  it("THE GAP CLOSED IN THE APP: a HELD IFC document is not put in force — the save is refused with the hold named, nothing saved; an unreadable hold state refuses too", async () => {
    for (const mode of ["held", "unreadable"] as const) {
      s.holdReads = [];
      if (mode === "held") { s.holds = { d1: [{ id: "h1", reason: "Client Review" }] }; s.holdReadError = null; }
      else { s.holds = {}; s.holdReadError = { message: "network down" }; }
      const onSave = vi.fn(async () => {});
      const onClose = vi.fn();
      await act(async () => {
        root.render(React.createElement(MetadataEditor, {
          isOpen: true, onClose, document: { ...IFC_DOC }, columns: [] as never,
          userRole: "DocCtrl", userRoles: ["DocCtrl"], onSave: onSave as never,
        }));
      });
      await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Locked"));
      expect(host.querySelector('[data-testid="entry-into-force-note"]')).not.toBeNull();
      await act(async () => { button("Save").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(onSave, mode).not.toHaveBeenCalled();
      expect(onClose, mode).not.toHaveBeenCalled();
      const alert = host.querySelector('[role="alert"]')!.textContent!;
      expect(alert, mode).toMatch(mode === "held"
        ? /^Document has an active hold \(Client Review\); release the hold before putting it in force\. The status was not changed to Locked, and nothing else in this edit was saved/
        : /^Couldn't confirm this document is free of holds \(network down\); it is treated as held — retry putting it in force once the hold state can be read\./);
      await act(async () => root.render(React.createElement("div")));
    }
  });
  it("REGRESSION: an IFC document moved to a status that is NOT in force (Draft / Superseded / Void) reads no hold and shows no note", async () => {
    const onSave = vi.fn(async () => {});
    await act(async () => {
      root.render(React.createElement(MetadataEditor, {
        isOpen: true, onClose: vi.fn(), document: IFC_DOC, columns: [] as never,
        userRole: "DocCtrl", userRoles: ["DocCtrl"], onSave: onSave as never,
      }));
    });
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Superseded"));
    expect(host.querySelector('[data-testid="entry-into-force-note"]')).toBeNull();
    await act(async () => { button("Save").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(s.holdReads).toEqual([]);
    expect(((onSave.mock.calls[0] as unknown[])[0] as { core: { status: string } }).core.status).toBe("Superseded");
  });
  it("REGRESSION: the bulk editor offers exactly its list (no IFC) and a bulk status edit still writes every row", async () => {
    const LIB = { id: "lib", customColumns: [], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;
    const docs = [
      { id: "a1", documentNumber: "A1", title: "a1", rev: "0", status: "Issued", metadata: {}, currentVersionId: "v" },
      { id: "a2", documentNumber: "A2", title: "a2", rev: "0", status: "IFC", metadata: {}, currentVersionId: "v" },
    ] as unknown as DocumentRecord[];
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: "me" }));
    });
    const sel = labelled("New value") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual([...BULK_EDIT_STATUS_OPTIONS]);
    await act(async () => setValue(sel, "Superseded"));
    await act(async () => { button("Apply to 2").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.calls.map((c) => [c.id, c.payload.status])).toEqual([["a1", "Superseded"], ["a2", "Superseded"]]);
    expect(s.holdReads).toEqual([]); // nothing entered force: no hold read
  });
  it("the bulk editor names the IFC rows Issued would put in force with no database check, checks each one's hold, refuses a held one and writes the rest", async () => {
    const LIB = { id: "lib", customColumns: [], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;
    const docs = [
      { id: "b1", documentNumber: "B1", title: "b1", rev: "0", status: "IFC", metadata: {}, currentVersionId: "v" },
      { id: "b2", documentNumber: "B2", title: "b2", rev: "0", status: "IFC", metadata: {}, currentVersionId: "v" },
      { id: "b3", documentNumber: "B3", title: "b3", rev: "0", status: "Issued", metadata: {}, currentVersionId: "v" },
      { id: "b4", documentNumber: "B4", title: "b4", rev: "0", status: "IFC", metadata: {}, currentVersionId: null },
    ] as unknown as DocumentRecord[];
    s.holds = { b2: [{ id: "h2", reason: "Other" }] };
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: "me" }));
    });
    expect(host.querySelector('[data-testid="bulk-entry-into-force-note"]')).toBeNull(); // default Draft
    await act(async () => setValue(labelled("New value") as HTMLSelectElement, "Issued"));
    const note = host.querySelector('[data-testid="bulk-entry-into-force-note"]')!.textContent!;
    expect(note).toMatch(/^2 of the selected rows \(B1, B2\) have statuses no gate reads as in force \(IFC\): setting Issued puts their current revision in force/);
    expect(note).toMatch(/The database does not check this change, so each row's hold is checked first and a held row is refused \(named after the apply\); the revision's review is not checked\./);
    expect(host.querySelector('[data-testid="bulk-issue-note"]')).toBeNull(); // not a REV-18 issue to the database
    await act(async () => { button("Apply to 4").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.holdReads).toEqual(["b1", "b2"]);
    expect(s.calls.map((c) => c.id)).toEqual(["b1", "b3", "b4"]); // the held row is never written
    const items = Array.from(host.querySelector('[data-testid="bulk-refused-rows"]')!.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual(["B2 — Document has an active hold (Other); release the hold before putting it in force."]);
  });
});

describe("P15 review fix — isUnguardedEntryIntoForce: the change into force the database's issue guard does not see", () => {
  it("IFC / an unknown or empty status → Issued / Locked, with a current revision; nothing else", () => {
    const t = (fromStatus: string | null, toStatus: string, hasCurrentRevision = true) => isUnguardedEntryIntoForce({ fromStatus, toStatus, hasCurrentRevision });
    for (const from of ["IFC", "Approved for Construction", "", null, " Issued"]) {
      for (const to of ["Issued", "Locked"]) expect(t(from, to), `${from} → ${to}`).toBe(true);
    }
    expect(t("IFC", "Issued", false)).toBe(false); // nothing to put in force
    for (const to of ["Draft", "In Review", "Superseded", "Void", "Archived", "IFC", " Issued"]) expect(t("IFC", to), `IFC → ${to}`).toBe(false);
    for (const from of ["Issued", "Locked"]) expect(t(from, "Issued"), `${from} → Issued`).toBe(false); // already in force
    // a REV-18 issue (the database guards it) is never this — the two never overlap
    for (const from of ["Draft", "In Review", "Superseded", "Void", "Archived"]) {
      expect(t(from, "Issued"), from).toBe(false);
      expect(isIssueTransition({ fromStatus: from, toStatus: "Issued", hasCurrentRevision: true }), from).toBe(true);
    }
    // the gap it covers is exactly what 20261144 leaves: no issue transition there, yet into force at both gates
    expect(isIssueTransition({ fromStatus: "IFC", toStatus: "Issued", hasCurrentRevision: true })).toBe(false);
    expect(printsInPack("IFC")).toBe(false);
    expect(printsInPack("Issued")).toBe(true);
  });
  it("both editors import it and check the hold through lib/holdGate.ts with the same action", () => {
    for (const f of ["components/documents/MetadataEditor.tsx", "components/documents/BulkEditModal.tsx"]) {
      const code = src(f);
      expect(code, f).toMatch(/isUnguardedEntryIntoForce\(\{ fromStatus: (document|d)\.status, toStatus: (status|newValue), hasCurrentRevision(: !!d\.currentVersionId)? \}\)/);
      expect(code, f).toMatch(/await assertNotOnHold\((document|doc)\.id, \{ action: ENTRY_INTO_FORCE_ACTION \}\)/);
      expect(code, f).toContain('import { assertNotOnHold');
    }
  });
});

describe("VFY-20 / DEC-44 (P15) review fix — the lifecycle board reads an existing IFC row one way too: not in force", () => {
  const card = (status: string | null, issueType: string | null): BoardDoc => ({
    id: "d", number: "P-1", title: "t", rev: "0", status, issueType, libraryId: null, updatedAt: null, checkedOutByName: null,
  });
  it("status IFC (or any unrecognised status) never lands in the construction-ready IFC / As-Built columns, whatever its issue type", () => {
    for (const issueType of ["Issued for Construction", "As-Built", "Internal Review", null]) {
      expect(lifecycleOf(card("IFC", issueType)), `IFC + ${issueType}`).toBe("Draft");
      expect(lifecycleOf(card("Approved for Construction", issueType)), `custom + ${issueType}`).toBe("Draft");
    }
    // its card says what it is
    expect(src("components/documents/LifecycleBoard.tsx")).toMatch(/\{!isRecognisedStatus\(d\.status\) && \(\s*\n[^\n]*\n\s*<span data-testid="board-status-not-recognised"[^>]*>\s*\n\s*\{d\.status\} · not in force/);
  });
  it("REGRESSION: every recognised status keeps its column exactly as before", () => {
    expect(lifecycleOf(card("Issued", "Issued for Construction"))).toBe("IFC");
    expect(lifecycleOf(card("Issued", null))).toBe("IFC");
    expect(lifecycleOf(card("Issued", "As-Built"))).toBe("As-Built");
    expect(lifecycleOf(card("Locked", "As-Built"))).toBe("As-Built");
    expect(lifecycleOf(card("Draft", "Internal Review"))).toBe("In Review");
    expect(lifecycleOf(card("In Review", null))).toBe("Draft");
    expect(lifecycleOf(card("Superseded", "Issued for Construction"))).toBe("Superseded");
    expect(lifecycleOf(card("Issued", "Void"))).toBe("Superseded");
    expect(lifecycleOf(card(null, null))).toBe("Draft");
    expect(lifecycleOf(card("Draft", null))).toBe("Draft");
  });
});
