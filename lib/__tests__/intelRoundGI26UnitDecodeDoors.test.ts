// intelligence Round G I-26 — GAP-314 acceptance 1, the other doors: a
// document created or renumbered through them asks for the unit decode after
// its write, best-effort (DEC-90: the decode never blocks or fails the write;
// a decode that did not run is SAID, never only logged).
//   * the library page's bulk upload (uploadOne) — ONE call after the batch,
//     for every document that landed; its note joins the batch's follow-ups;
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
  it("the bulk upload decodes every landed document in ONE call after the batch (never per file), and its note joins the follow-ups", () => {
    const decode = page.indexOf('await requestUnitCodeDecode(activeOrgId!, [...landedIds.values()], "upload")');
    expect(decode).toBeGreaterThan(0);
    expect(page.match(/requestUnitCodeDecode\(/g)).toHaveLength(2);
    // after the batch settled (its counts), before the report is composed
    expect(decode).toBeGreaterThan(page.indexOf("const landed = attempted - failures.length;"));
    expect(page).toMatch(/const unitDecode = landedIds\.size > 0\s*\? await requestUnitCodeDecode\(.*?"upload"\)\s*: \{ results: \[\], note: null \};/);
    expect(page.indexOf("if (unitDecode.note) notes.push(unitDecode.note);")).toBeGreaterThan(decode);
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
  it("the intake door decodes a document it CREATED, server-side, bounded, after the project reference — never a browser write", () => {
    const r = src("app/api/intake/upload/route.ts");
    const call = r.indexOf("await decodeCreatedDocument(ref, orgId, createdDocId, contactEmail);");
    expect(call).toBeGreaterThan(r.indexOf("project reference for ${createdDocId} not written"));
    expect(r).toMatch(/const \{ decodeDocumentUnitCodes \} = await import\("@\/lib\/unitCodeDecode"\);/);
    expect(r).toMatch(/Promise\.race\(\[\s*decodeDocumentUnitCodes\(\{ orgId, documentIds: \[documentId\] \}\)/);
  });
  it("the adoption that renumbers asks after the move", () => {
    const t = src("lib/transitionIn.ts");
    const fn = t.slice(t.indexOf("export async function adoptDocument"));
    expect(fn.indexOf('requestUnitCodeDecode(input.orgId, [input.docId], "renumber")')).toBeGreaterThan(fn.indexOf("// Keep the project tracking the document"));
    expect(fn).toContain("const unitNote = newNumber ? (await requestUnitCodeDecode(");
  });
});
