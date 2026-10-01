// @vitest-environment jsdom
//
// document-control Round F wave 2 — P12 WAVE-2 RESIDUALS: the library page's
// rails, the two deploy prerequisites of 20261131 (99-fix-sequencing.md).
//
//   DRLS-15  the metadata editor and the bulk editor stop writing
//            documents.rev (the label is the current revision's — 20261131's
//            register rail refuses a divergent one, and with it every other
//            edit in the statement); saveMetadata checks { error } and the
//            row count, and the editor stays open on a refusal and says why.
//            Integration fix: a document with NO current revision (a register
//            row with no file) keeps its label editable and sent — the rail
//            checks a label only against a current revision.
//   DRLS-17  the delete flow never clears the pointer first: ONE statement on
//            the document row (its revisions and their evidence go with it
//            through their own cascades), checked, so a refusal leaves the
//            document as it was.
//
// The two editors are driven AS RENDERED (jsdom); the page is a Next.js page
// module (no named exports), so its two handlers are pinned by source, and
// the database facts the one-statement delete stands on are pinned to the
// migrations that create them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; eq?: [string, unknown]; select?: string }>,
  // per document id: what the checked update answers
  answers: {} as Record<string, { data: Array<{ id: string }> | null; error: { message: string } | null }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: unknown) => ({
        eq: (col: string, val: unknown) => {
          const call = { table, op: "update", payload, eq: [col, val] as [string, unknown] };
          const settle = () => s.answers[String(val)] ?? { data: [{ id: String(val) }], error: null };
          return {
            select: (cols: string) => { s.calls.push({ ...call, select: cols }); return Promise.resolve(settle()); },
            then: (res: (v: unknown) => void) => { s.calls.push(call); res(settle()); },
          };
        },
      }),
    }),
  },
}));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/AssetTagChip", () => ({ default: () => null }));

import MetadataEditor from "@/components/documents/MetadataEditor";
import BulkEditModal from "@/components/documents/BulkEditModal";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGE = "app/(protected)/documents/[libraryId]/page.tsx";
/** The body of `const <name> = async (` up to the next `const ` at the same indent. */
function handler(file: string, name: string): string {
  const text = src(file);
  const start = text.indexOf(`  const ${name} = async (`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const next = text.indexOf("\n  const ", start + 10);
  return text.slice(start, next < 0 ? undefined : next);
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.calls = []; s.answers = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === label || x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
};
const text = () => host.textContent ?? "";

const DOC = {
  id: "d1", documentNumber: "P-101", title: "Overhead P&ID", rev: "3", status: "Issued",
  metadata: { unit: "CDU" }, libraryId: "lib", currentVersionId: "d1-v3",
} as unknown as DocumentRecord;
/** A register row with no file (a CSV import): no current revision. */
const POINTERLESS = { ...DOC, id: "d2", documentNumber: "P-102", rev: "A", currentVersionId: undefined } as unknown as DocumentRecord;

// ── DRLS-15 — the metadata editor ───────────────────────────────────────────
describe("DRLS-15 — the metadata editor never sends the revision label of a document with a current revision, and a refused save stays open", () => {
  async function open(onSave: (p: unknown) => Promise<void>, onClose = vi.fn(), document: DocumentRecord = DOC, userRoles = ["Manager", "DocCtrl"]) {
    await act(async () => {
      root.render(React.createElement(MetadataEditor, {
        isOpen: true, onClose, document,
        columns: [{ key: "unit", label: "Unit", type: "text" }] as never,
        userRole: "Manager", userRoles, // additive DocCtrl may edit
        onSave: onSave as never,
      }));
    });
    return onClose;
  }

  it("Revision is shown read-only (the current revision's label) and is not part of the payload", async () => {
    const onSave = vi.fn(async () => {});
    const onClose = await open(onSave);
    const rev = labelled("Revision") as HTMLInputElement;
    expect(rev.value).toBe("3");
    expect(rev.readOnly).toBe(true);
    expect(rev.disabled).toBe(true);
    expect(text()).toMatch(/Correct it on the revision in the history panel/);
    await act(async () => setValue(labelled("Unit") as HTMLInputElement, "VDU"));
    await click(button("Save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = (onSave.mock.calls[0] as unknown[])[0] as { metadata: Record<string, unknown>; core: Record<string, unknown> };
    expect(payload.metadata).toEqual({ unit: "VDU" });
    expect(Object.keys(payload.core).sort()).toEqual(["documentNumber", "status", "title"]);
    expect("rev" in payload.core).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a refused save keeps the dialog open and shows the refusal; it never closes as if saved", async () => {
    const onSave = vi.fn(async () => { throw new Error("Save refused — nothing was saved: permission denied"); });
    const onClose = await open(onSave);
    await click(button("Save"));
    await tick();
    expect(onClose).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Save refused — nothing was saved: permission denied");
    expect(button("Save").disabled).toBe(false); // can retry
  });

  it("a document with NO current revision (a register row with no file) keeps Revision editable, shows no pointer to a revision it lacks, and sends the label", async () => {
    const onSave = vi.fn(async () => {});
    const onClose = await open(onSave, vi.fn(), POINTERLESS);
    const rev = labelled("Revision") as HTMLInputElement;
    expect(rev.value).toBe("A");
    expect(rev.readOnly).toBe(false);
    expect(rev.disabled).toBe(false);
    expect(text()).not.toMatch(/Correct it on the revision in the history panel/);
    await act(async () => setValue(rev, "B"));
    await click(button("Save"));
    const payload = (onSave.mock.calls[0] as unknown[])[0] as { core: Record<string, unknown> };
    expect(Object.keys(payload.core).sort()).toEqual(["documentNumber", "rev", "status", "title"]);
    expect(payload.core.rev).toBe("B");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on a pointerless row a member who may not edit sees Revision disabled, like every other core field", async () => {
    await open(vi.fn(async () => {}), vi.fn(), POINTERLESS, ["Engineer"]);
    const rev = labelled("Revision") as HTMLInputElement;
    expect(rev.disabled).toBe(true);
    expect((labelled("Document Number") as HTMLInputElement).disabled).toBe(true);
  });

  it("the save payload's rev is documented and sent for a pointerless document only", () => {
    const ed = src("components/documents/MetadataEditor.tsx");
    const iface = ed.slice(ed.indexOf("export interface MetadataEditorSavePayload"), ed.indexOf("export default function MetadataEditor"));
    expect(iface).toMatch(/sent ONLY for a document with no current revision[\s\S]*\brev\?: string;/);
    expect(ed).toMatch(/const hasCurrentRevision = !!document\.currentVersionId;/);
    expect(ed).toMatch(/core: hasCurrentRevision \? \{ title, documentNumber, status \} : \{ title, documentNumber, rev, status \},/);
  });
});

// ── DRLS-15 — saveMetadata on the library page ──────────────────────────────
describe("DRLS-15 — the page's saveMetadata writes rev only for a document with no current revision, and checks the write", () => {
  const body = handler(PAGE, "saveMetadata");
  it("puts rev into the documents UPDATE only when the document has no current revision; otherwise the uniqueness key keeps the stored label", () => {
    expect(body).toMatch(/const revEditable = !selectedDoc\.currentVersionId && next\.core\?\.rev !== undefined;/);
    expect(body.match(/payload\.rev\b/g)).toHaveLength(1);
    expect(body).toMatch(/if \(revEditable\) payload\.rev = next\.core\?\.rev;/);
    expect(body).toMatch(/rev: revEditable \? next\.core\?\.rev : selectedDoc\.rev,/);
    expect(body).not.toMatch(/payload\.revision\b/);
  });
  it("20261131's register rail (the newest definition) admits a publisher's label change on a pointerless row: the label check runs only when there IS a current revision", () => {
    const defs = readdirSync(join(process.cwd(), "supabase/migrations"))
      .filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_register_rail\(/.test(src(`supabase/migrations/${f}`)));
    expect(defs).toEqual(["20261131_dc_roundF_documents_rails.sql"]);
    const rail = src("supabase/migrations/20261131_dc_roundF_documents_rails.sql");
    const fn = rail.slice(rail.indexOf("CREATE OR REPLACE FUNCTION enforce_document_register_rail()"), rail.indexOf("DROP TRIGGER IF EXISTS trg_document_register_rail"));
    // a label change by a signed-in caller takes the publisher tier (the editor's canEdit is a controller)…
    expect(fn).toMatch(/IF \(v_rev_moved\s*\n\s*OR NEW\.document_number IS DISTINCT FROM OLD\.document_number\s*\n\s*OR v_eff_moved\)\s*\n\s*AND NOT is_org_controller\(NEW\.org_id\)/);
    // …and the label must equal the current revision's ONLY when there is one
    expect(fn).toMatch(/IF NEW\.current_version_id IS NOT NULL AND \(v_ptr_moved OR v_rev_moved\) THEN/);
    expect(fn.match(/must match its current revision/g)).toHaveLength(1);
  });
  it("checks { error } and the row count, and throws (the editor shows it) instead of returning as saved", () => {
    expect(body).toMatch(/const \{ data: saved, error: saveErr \} = await supabase\s*\n?\s*\.from\("documents"\)\.update\(payload\)\.eq\("id", selectedDoc\.id\)\.select\("id"\);/);
    expect(body).toMatch(/if \(saveErr\) throw new Error\(`Save refused — nothing was saved: \$\{saveErr\.message\}`\);/);
    expect(body).toMatch(/if \(!saved \|\| saved\.length === 0\) \{\s*throw new Error\("Save refused — nothing was saved:/);
    // no unchecked documents write remains in the handler
    expect(body).not.toMatch(/await supabase\.from\("documents"\)\.update\(payload\)\.eq\("id", selectedDoc\.id\);/);
  });
});

// ── DRLS-15 — the bulk editor ───────────────────────────────────────────────
describe("DRLS-15 — the bulk editor offers no Revision field and checks every row", () => {
  const LIB = { id: "lib", customColumns: [{ key: "unit", label: "Unit", type: "text" }], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;
  const DOCS = [
    { id: "a", documentNumber: "A-1", title: "A", rev: "1", status: "Issued", metadata: {} },
    { id: "b", documentNumber: "B-1", title: "B", rev: "2", status: "Issued", metadata: {} },
  ] as unknown as DocumentRecord[];
  async function open() {
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: DOCS, library: LIB, actorUserId: "me" }));
    });
  }

  it("the field picker lists Status and the custom columns — never Revision", async () => {
    await open();
    const picker = labelled("Field to change") as HTMLSelectElement;
    const opts = Array.from(picker.options).map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([["status", "Status"], ["custom:unit", "Unit (custom)"]]);
  });

  it("a bulk write sends no rev, and a row the database filtered to nothing is reported failed, not applied", async () => {
    s.answers.b = { data: [], error: null }; // RLS filtered the write: zero rows, no error
    await open();
    await act(async () => setValue(labelled("Field to change") as HTMLSelectElement, "custom:unit"));
    await act(async () => setValue(labelled("New value") as HTMLInputElement, "VDU"));
    await click(button("Apply to 2"));
    await tick();
    const writes = s.calls.filter((c) => c.table === "documents" && c.op === "update");
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.select).toBe("id"); // checked
      expect("rev" in (w.payload as Record<string, unknown>)).toBe(false);
    }
    expect(text()).toMatch(/Applied to 1 document\./);
    expect(text()).toMatch(/1 failed/);
    expect(text()).toMatch(/B-1 — refused — the database updated nothing/);
  });

  it("a refused row (the database error) is reported with its reason", async () => {
    s.answers.a = { data: null, error: { message: "Only a publisher on this library may change it" } };
    await open();
    await click(button("Apply to 2"));
    await tick();
    expect(text()).toMatch(/A-1 — Only a publisher on this library may change it/);
    expect(text()).toMatch(/Applied to 1 document\./);
  });

  it("the source keeps no rev branch", () => {
    const b = src("components/documents/BulkEditModal.tsx");
    expect(b).not.toMatch(/kind: "rev"/);
    expect(b).not.toMatch(/updates\.rev\b/);
    expect(b).not.toMatch(/<option value="rev">/);
  });
});

// ── DRLS-17 — confirmDeleteDoc ──────────────────────────────────────────────
describe("DRLS-17 — the delete flow is one checked statement on the document row", () => {
  const body = handler(PAGE, "confirmDeleteDoc");
  it("never clears the pointer and never deletes the revisions on their own", () => {
    expect(body).not.toMatch(/current_version_id:\s*null/);
    expect(body).not.toMatch(/from\("document_versions"\)/);
    expect(body.match(/\.delete\(\)/g)).toHaveLength(1);
    expect(body.match(/\.update\(/g)).toBeNull();
  });
  it("deletes the document row, checks the error and the row count BEFORE touching local state", () => {
    const del = body.indexOf('.from("documents")\n        .delete()\n        .eq("id", docId)\n        .select("id");');
    expect(del).toBeGreaterThan(0);
    const errCheck = body.indexOf("if (delErr) throw new Error(");
    const rowCheck = body.indexOf("if (!deleted || deleted.length === 0) {");
    const local = body.indexOf("setDocuments(prev => prev.filter(d => d.id !== docId));");
    expect(errCheck).toBeGreaterThan(del);
    expect(rowCheck).toBeGreaterThan(errCheck);
    expect(local).toBeGreaterThan(rowCheck);
    // the refusal is surfaced, loudly
    expect(body).toMatch(/setError\(`Delete failed: \$\{msg\}`\);/);
    expect(body).toMatch(/await appAlert\(\{ title: "Delete failed"/);
  });
  it("the database facts the single statement stands on: revisions and their evidence cascade from the document; the pointer is no FK", () => {
    const schema = src("supabase/schema.sql");
    expect(schema).toMatch(/record_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE,/);
    expect(schema).toMatch(/\n  current_version_id UUID,\n/); // no REFERENCES — nothing to detach first
    expect(src("supabase/migrations/20260817_read_understood.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
    expect(src("supabase/migrations/20260818_review_before_publish.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
    expect(src("supabase/migrations/20260825_work_packages_acks.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE,\n\s*version_id UUID NOT NULL REFERENCES document_versions\(id\) ON DELETE CASCADE/);
    expect(schema).toMatch(/document_id UUID REFERENCES documents\(id\) ON DELETE CASCADE,\n\s*version_id UUID REFERENCES document_versions\(id\),/); // download_audits
    // 20261131's current-revision rail asks whether a DOCUMENT still names the
    // deleted revision — a cascaded delete from the document finds none.
    const rails = src("supabase/migrations/20261131_dc_roundF_documents_rails.sql");
    expect(rails).toMatch(/CREATE CONSTRAINT TRIGGER trg_document_versions_pointer_rail\n\s*AFTER DELETE ON document_versions/);
    expect(rails).toMatch(/IF EXISTS \(SELECT 1 FROM documents d WHERE d\.current_version_id = OLD\.id\) THEN/);
  });
});
