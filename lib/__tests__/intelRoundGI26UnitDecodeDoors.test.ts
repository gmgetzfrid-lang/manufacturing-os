// intelligence Round G I-26 — GAP-314 acceptance 1, the other doors: a
// document created or renumbered through them asks for the unit decode after
// its write, best-effort (DEC-90: the decode never blocks or fails the write;
// a decode that did not run is SAID, never only logged).
//   * the library page's bulk upload (uploadOne) — ONE call after the batch
//     and its report, for every document that landed, NOT awaited (the modal,
//     the upload dock and the AI-library nudge never wait on it); its note is
//     said once it settles, after whatever the batch said;
//   * the library page's inline number edit (saveInlineDocNumber) — after the
//     save landed, not awaited; a note is shown on the page;
//   * the link picker — asks itself (createDocumentWithFile told not to), so
//     its note is shown once it settles;
//   * the template filing — GenerateModal shows `unitCodeNote` with the result.
// The intake door (service role, lib/unitCodeDecode directly) and the
// transition-in adoption are pinned by behaviour in intakeUploadRoute.test.ts
// and transitionIn.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("GAP-314 (I-26) — the library page", () => {
  const page = src("app/(protected)/documents/[libraryId]/page.tsx");
  it("the bulk upload decodes every landed document in ONE call after the batch AND its report (never per file), NOT awaited — the upload closes whatever the route does", () => {
    const fn = page.slice(page.indexOf("const handleStagedUpload = async"), page.indexOf("const saveMetadata = async"));
    const decode = fn.indexOf('void requestUnitCodeDecode(activeOrgId!, [...landedIds.values()], "upload")');
    expect(decode).toBeGreaterThan(0);
    expect(page.match(/requestUnitCodeDecode\(/g)).toHaveLength(2);
    expect(page).not.toMatch(/await requestUnitCodeDecode/);
    // after the batch settled, after the report was composed and the modal closed
    expect(decode).toBeGreaterThan(fn.indexOf("const landed = attempted - failures.length;"));
    expect(decode).toBeGreaterThan(fn.indexOf('if (notes.length > 0) setError(`Uploaded. ${notes.join(" ")}`);'));
    expect(decode).toBeGreaterThan(fn.indexOf("setShowStagingModal(false);"));
    expect(decode).toBeGreaterThan(fn.indexOf("nudgeKnowledgeSources(activeOrgId!, libraryId);"));
    // still inside the try — before the finally that closes the upload dock
    expect(decode).toBeLessThan(fn.indexOf("endUpload();"));
    // the report itself no longer waits on (or carries) the decode
    expect(fn).not.toContain("unitDecode");
    // the note is said once it settles, after whatever the batch already said
    expect(fn.slice(decode, decode + 400)).toMatch(/setError\(\(prev\) => \(prev \? `\$\{prev\} \$\{note\}` : `Uploaded\. \$\{note\}`\)\);/);
  });
  it("the decode is fired only when something landed", () => {
    const fn = page.slice(page.indexOf("const handleStagedUpload = async"), page.indexOf("const saveMetadata = async"));
    const decode = fn.indexOf('void requestUnitCodeDecode(activeOrgId!, [...landedIds.values()], "upload")');
    expect(fn.slice(decode - 60, decode)).toContain("if (landedIds.size > 0) {");
  });
  it("the inline number edit decodes after the save landed, NOT awaited, and shows a note on the page", () => {
    const fn = page.slice(page.indexOf("saveInlineDocNumber"));
    const call = fn.indexOf('void requestUnitCodeDecode(activeOrgId, [docId], "renumber")');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(fn.indexOf("setEditingDocNumId(null);"));
    expect(fn.slice(call, call + 300)).toMatch(/if \(r\.note\) \{ console\.warn\(`\[saveInlineDocNumber\] \$\{r\.note\}`\); setError\(`\$\{trimmed\} was renumbered\. \$\{r\.note\}`\); \}/);
  });
});

describe("GAP-314 (I-26) — the console-only doors now say it", () => {
  it("the link picker asks for the decode itself after the creation, not awaited, and shows a note once it settles", () => {
    const p = src("components/documents/DocumentLinkPicker.tsx");
    const create = p.indexOf("await createDocumentWithFile({");
    expect(p.slice(create, create + 600)).toContain("decodeUnitCode: false,");
    const call = p.indexOf('void requestUnitCodeDecode(orgId, [documentId], "upload")');
    expect(call).toBeGreaterThan(create);
    expect(p.slice(call, call + 300)).toMatch(/void appAlert\(\{ message: `\$\{createdNumber\} was created and linked\. \$\{r\.note\}` \}\)/);
    expect(p).not.toMatch(/await requestUnitCodeDecode/);
  });
  it("the template filing's unitCodeNote is in the result toast (both branches)", () => {
    const g = src("components/templates/GenerateModal.tsx");
    expect(g).toContain('message: [res.errors.slice(0, 3).join("; "), res.unitCodeNote].filter(Boolean).join(" "),');
    expect(g).toContain('type: res.unitCodeNote ? "warning" : "success",');
    expect(g).toContain("...(res.unitCodeNote ? { message: res.unitCodeNote } : {}),");
  });
});

describe("GAP-314 (I-26) — the intake door and the adoption", () => {
  it("the intake door decodes a document it CREATED, server-side, bounded, after the project reference and after the response — never a browser write", () => {
    const r = src("app/api/intake/upload/route.ts");
    const call = r.indexOf("scheduleCreatedDocumentDecode(ref, orgId, createdDocId, contactEmail);");
    expect(call).toBeGreaterThan(r.indexOf("project reference for ${createdDocId} not written"));
    // after the response (next/server after()), never awaited by the door
    expect(r).not.toMatch(/await decodeCreatedDocument/);
    expect(r).toContain("after(() => decodeCreatedDocument(ref, orgId, documentId, contactEmail));");
    expect(r).toMatch(/const \{ decodeDocumentUnitCodes \} = await import\("@\/lib\/unitCodeDecode"\);/);
    expect(r).toMatch(/Promise\.race\(\[\s*decodeDocumentUnitCodes\(\{ orgId, documentIds: \[documentId\] \}\)/);
  });
  it("the adoption that renumbers asks after the move, NOT awaited, and the panel says the note after the adoption's sentence", () => {
    const t = src("lib/transitionIn.ts");
    const fn = t.slice(t.indexOf("export async function adoptDocument"));
    expect(fn.indexOf('void requestUnitCodeDecode(input.orgId, [input.docId], "renumber")')).toBeGreaterThan(fn.indexOf("// Keep the project tracking the document"));
    expect(t).not.toMatch(/await requestUnitCodeDecode/);
    const panel = src("components/projects/TransitionInPanel.tsx");
    expect(panel.match(/onUnitCodeNote,\n/g)).toHaveLength(2);
    expect(panel.match(/const onUnitCodeNote = \(n: string\) => \{ if \(reported\) setMsg\(\(prev\) => \(prev \? `\$\{prev\} \$\{n\}` : n\)\); else unitNotes\.push\(n\); \};/g)).toHaveLength(2);
    expect(panel).toContain('setMsg([res.note ?? `${c.label} adopted into the controlled register.`, ...unitNotes].join(" "));');
    expect(panel).toContain('+ unkeyedText + (unitNotes.length ? ` ${unitNotes.join(" ")}` : ""));');
  });
});
