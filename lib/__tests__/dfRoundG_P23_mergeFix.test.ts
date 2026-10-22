// drafting-flow Round G, DF-P23 merge-time fix pass — two of the final
// review's minors (the integrator's rulings, DEC-90):
//
//   * (ruling 2) GAP-101's declaration on the deliverable stamp: a part the
//     stamp's WinAnsi font cannot draw (a Cyrillic statement, a CJK name)
//     was printed as "?" runs. Each part — the name, the statement — is now
//     checked on its own against the font's own encoder, and a part that
//     cannot be drawn without a "?" is replaced by a plain-ASCII note naming
//     the request; a part it can draw is printed byte for byte as before.
//   * (ruling 6) restoring, after 20261265, a backup taken before it that
//     lists one tag twice on one request: the first entry is kept, the later
//     one is not written — reported (notApplied, "duplicate equipment tag on
//     this request — kept the first") and counted (existing), never refused,
//     never a failed chunk. Before the paste a restore writes what it wrote.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  ticketCopyPlan, declarationFooterClause, declarationPartNotPrintable, stampPrintsWithoutSubstitute, foldForStamp,
  type TicketCopyDeclaration,
} from "@/lib/ticketDeliverableCopy";
import { stampText, withoutScanInstruction } from "@/lib/stamping";
import { db, from, type Row } from "./helpers/restoreMemoryDb";
import { applyRestoreChunk, DUPLICATE_EQUIPMENT_TAG, DUPLICATE_EQUIPMENT_TAG_REASON, restoreRefusalLabel } from "@/lib/dataRestore";
import { equipmentListingKey } from "@/lib/ticketEquipment";

// ── ruling 2: the declaration on the stamp ──────────────────────────────────
const at = "2026-10-01T09:00:00Z";
const decl = (by: string | null, statement: string | null, extra: Partial<TicketCopyDeclaration> = {}): TicketCopyDeclaration =>
  ({ by, declaredAt: at, statement, ...extra });
const footerOf = (d: TicketCopyDeclaration, ticketNumber: string | null = "KE-1") => ticketCopyPlan({
  file: { type: "Final", rev: "1", id: "f1" }, ticketNumber, ticketRowId: "t1", origin: "https://plant.test", channel: "print",
  live: { status: "CLOSED", deliverableRev: "1", history: [], declaration: d },
}).footerNotice;
/** What the stamper draws: no "?" substitute, and the font encodes it all. */
async function drawsWithoutSubstitute(text: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const drawn = stampText(text);
  expect(drawn.mapped.filter((m) => m.printedAs === "?"), text).toEqual([]);
  expect(() => font.encodeText(drawn.text)).not.toThrow();
  for (const variant of [drawn.text, withoutScanInstruction(drawn.text)]) expect(variant).not.toMatch(/\?/);
}

describe("GAP-101 (DF-P23 merge-time fix pass, ruling 2) — a declaration part the stamp's font cannot draw is never printed as '?'", () => {
  it("a Cyrillic statement: replaced by a plain-ASCII note naming the request; the Latin name kept", async () => {
    const clause = declarationFooterClause(decl("Pat O'Neil", "Замена прокладки на идентичную"), "KE-1");
    expect(clause).toBe(" (declared like-in-kind by Pat O'Neil on 2026-10-01: [statement not printable in this stamp - see request KE-1])");
    const footer = footerOf(decl("Pat O'Neil", "Замена прокладки на идентичную"));
    expect(footer).toContain("[statement not printable in this stamp - see request KE-1]");
    expect(footer).toMatch(/not a controlled document revision/);
    await drawsWithoutSubstitute(footer);
  });
  it("a CJK name: replaced by a note, the statement kept as written", async () => {
    const clause = declarationFooterClause(decl("王伟", "Identical gasket, same rating"), "KE-1");
    expect(clause).toBe(' (declared like-in-kind by the requester [name not printable in this stamp - see request KE-1] on 2026-10-01: "Identical gasket, same rating")');
    await drawsWithoutSubstitute(footerOf(decl("王伟", "Identical gasket, same rating")));
  });
  it("mixed: a mostly-Latin statement with one Cyrillic word is replaced whole (never a '?' inside the quotation); a name mixing scripts likewise; both parts at once; each part decided on its own", async () => {
    expect(declarationFooterClause(decl("Pat", "Same pump as насос P-101"), "KE-1"))
      .toBe(" (declared like-in-kind by Pat on 2026-10-01: [statement not printable in this stamp - see request KE-1])");
    expect(declarationFooterClause(decl("Li 李", "Same pump"), "KE-1"))
      .toBe(' (declared like-in-kind by the requester [name not printable in this stamp - see request KE-1] on 2026-10-01: "Same pump")');
    const both = decl("Иван Петров", "宽度相同的垫片", { signatureUnchecked: true });
    expect(declarationFooterClause(both, "KE-1")).toBe(
      " (declared like-in-kind by the requester [name not printable in this stamp - see request KE-1] on 2026-10-01: [statement not printable in this stamp - see request KE-1]; e-signature not checked)",
    );
    for (const d of [decl("Pat", "Same pump as насос P-101"), decl("Li 李", "Same pump"), both]) await drawsWithoutSubstitute(footerOf(d));
    // with no request number the note still says where to look
    expect(declarationPartNotPrintable("statement", null)).toBe("[statement not printable in this stamp - see the request]");
    expect(footerOf(decl("Pat", "Замена"), null)).toContain("[statement not printable in this stamp - see the request]");
  });
  it("REGRESSION: plain Latin (accents, curly quotes, en / em dashes, the ellipsis, a scan instruction) is byte-identical to the stamp before this pass", () => {
    // captured from lib/ticketDeliverableCopy.ts at 04bc73f (the commit before this pass)
    expect(declarationFooterClause(decl("Pat O'Neil", "Replacing the gasket with an identical one — same rating, same material"), "KE-1"))
      .toBe(" (declared like-in-kind by Pat O'Neil on 2026-10-01: \"Replacing the gasket with an identical one - same rating, same material\")");
    const latin = decl("José Müller", "Like-for-like “spiral wound” gasket, 150# – ASME B16.20…", { signatureUnchecked: true });
    expect(declarationFooterClause(latin, "KE-1"))
      .toBe(" (declared like-in-kind by José Müller on 2026-10-01: \"Like-for-like “spiral wound” gasket, 150# - ASME B16.20…\"; e-signature not checked)");
    expect(declarationFooterClause({ by: null, declaredAt: null, statement: "Identical pump; scan the QR on the nameplate" }, "KE-1"))
      .toBe(" (declared like-in-kind by the requester: \"Identical pump; [scan] the QR on the nameplate\")");
    expect(footerOf(latin)).toBe("This file is KE-1 (declared like-in-kind by José Müller on 2026-10-01: \"Like-for-like “spiral wound” gasket, 150# - ASME B16.20…\"; e-signature not checked) deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    // the clause reads the same with or without the request number when every part prints
    expect(declarationFooterClause(latin)).toBe(declarationFooterClause(latin, "KE-1"));
  });
  it("fix pass 2 (review nit): a Latin-script name or statement with a letter the font lacks is printed diacritic-folded — 'Łukasz Nowak', 'Dvořák' — never replaced whole; a Cyrillic name still takes the note", async () => {
    expect(declarationFooterClause(decl("Łukasz Nowak", "Identical gasket"), "KE-1"))
      .toBe(' (declared like-in-kind by Lukasz Nowak on 2026-10-01: "Identical gasket")');
    // only the letters the font lacks are folded; "á" (a WinAnsi letter) is kept as typed
    expect(declarationFooterClause(decl("Antonín Dvořák", "Same pump"), "KE-1"))
      .toBe(' (declared like-in-kind by Antonín Dvorák on 2026-10-01: "Same pump")');
    // decomposed input folds the same way
    expect(foldForStamp("Dvor\u030Cák")).toBe("Dvorák");
    expect(declarationFooterClause(decl("Pat", "Spare from Łódź, same ĐN-50 flange"), "KE-1"))
      .toBe(' (declared like-in-kind by Pat on 2026-10-01: "Spare from Lódz, same DN-50 flange")');
    expect(declarationFooterClause(decl("Иван Петров", "Same pump"), "KE-1"))
      .toBe(' (declared like-in-kind by the requester [name not printable in this stamp - see request KE-1] on 2026-10-01: "Same pump")');
    // a Latin name with a CJK part folds nothing useful: the note
    expect(declarationFooterClause(decl("Łukasz 李", "Same pump"), "KE-1")).toContain("[name not printable in this stamp - see request KE-1]");
    expect(foldForStamp("Øystein Straße")).toBe("Øystein Straße"); // WinAnsi letters, printed as typed
    for (const d of [decl("Łukasz Nowak", "Identical gasket"), decl("Antonín Dvořák", "Same pump"), decl("Pat", "Spare from Łódź, same ĐN-50 flange")]) await drawsWithoutSubstitute(footerOf(d));
  });
  it("a character the stamper already prints in a plain form (a Unicode hyphen, a zero-width space) is not a '?' — that part is printed as before", () => {
    const d = decl("Pat", "Pump P‐101, same​model");
    expect(declarationFooterClause(d, "KE-1")).toBe(" (declared like-in-kind by Pat on 2026-10-01: \"Pump P‐101, same​model\")");
    expect(stampPrintsWithoutSubstitute("Pump P‐101")).toBe(true);
    expect(stampPrintsWithoutSubstitute("Насос")).toBe(false);
    expect(stampPrintsWithoutSubstitute("王伟")).toBe(false);
    expect(stampPrintsWithoutSubstitute("Pump \u{1F600}")).toBe(false);
    expect(stampPrintsWithoutSubstitute("Is it identical? Yes")).toBe(true); // a typed "?" is the requester's own
  });
  it("the font checked is the one the stamper embeds (Helvetica-Bold), through pdf-lib's own encoder", () => {
    const stamping = readFileSync(join(process.cwd(), "lib", "stamping.ts"), "utf8");
    expect(stamping).toContain("await pdfDoc.embedFont(StandardFonts.HelveticaBold)");
    const copy = readFileSync(join(process.cwd(), "lib", "ticketDeliverableCopy.ts"), "utf8");
    expect(copy).toContain("StandardFontEmbedder.for(StandardFonts.HelveticaBold as unknown as");
  });
});

// ── ruling 6: a backup that lists one tag twice ─────────────────────────────
const ORG = "org-target";
const T1 = "t-1";
const T2 = "t-2";
const sb = { from } as never;
const remap = { orgId: { "backup-org": ORG }, uid: { "old-req": "new-req" } };
const INDEX_MSG = 'duplicate key value violates unique constraint "ticket_equipment_ticket_tag_key_uniq"';
let indexPasted = true;
let refuseTag: string | null = null;
const eq = (id: string, ticket: string, tag: string): Row =>
  ({ id, org_id: "backup-org", ticket_id: ticket, tag, asset_id: null, created_by: "old-req", created_at: "2026-09-01T00:00:00Z" });
const listed = () => ((db.rows.ticket_equipment ?? []) as Row[]).map((r) => `${r.ticket_id}:${r.tag}`).sort();

beforeEach(() => {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }],
    tickets: [{ id: T1, org_id: ORG }, { id: T2, org_id: ORG }],
    users: [{ id: "new-req" }],
    org_members: [{ org_id: ORG, uid: "new-req", email: "req@plant.test", status: "active" }],
  };
  db.keys = {};
  db.readError = {};
  db.writes = [];
  db.attempts = [];
  db.countless = false;
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
  db.missingColumns = {};
  indexPasted = true;
  refuseTag = null;
  // 20261265's unique index on (ticket_id, ticket_equipment_tag_key(tag)) —
  // an expression key no ON CONFLICT column list names — as Postgres raises
  // it: the whole statement refused 23505 when, after ON CONFLICT (id) DO
  // NOTHING skips the ids already here, two rows of one request share a key.
  db.writeError = (table, op, rows) => {
    if (table !== "ticket_equipment" || op !== "upsert") return null;
    if (refuseTag && rows.some((r) => r.tag === refuseTag)) return { code: "23514", message: "new row violates check constraint" };
    if (!indexPasted) return null;
    const live = (db.rows.ticket_equipment ?? []) as Row[];
    const ids = new Set(live.map((r) => r.id));
    const seen = new Set(live.map((r) => `${r.ticket_id}|${equipmentListingKey(String(r.tag))}`));
    for (const r of rows) {
      if (ids.has(r.id)) continue;
      const k = `${r.ticket_id}|${equipmentListingKey(String(r.tag))}`;
      if (seen.has(k)) return { code: "23505", message: INDEX_MSG };
      seen.add(k);
    }
    return null;
  };
});

describe("GAP-312 follow-up (DF-P23 merge-time fix pass, ruling 6) — restoring a pre-20261265 backup that lists a tag twice on one request", () => {
  const backup = [eq("e1", T1, "E-22"), eq("e2", T1, "P-101"), eq("e3", T1, "E22"), eq("e4", T2, "E22"), eq("e5", T1, "e 22")];

  it("keeps the first entry per (request, tag key), skips each later one with the reason, counts it — never a refusal, never a failed chunk", async () => {
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup });
    expect(r.ok).toBe(true);
    expect(r.refused).toEqual([]);
    expect(r.inserted).toBe(3);
    expect(r.existing).toBe(2);
    expect(listed()).toEqual(["t-1:E-22", "t-1:P-101", "t-2:E22"]);
    expect(r.notApplied.map((n) => [n.id, n.code])).toEqual([["e3", DUPLICATE_EQUIPMENT_TAG], ["e5", DUPLICATE_EQUIPMENT_TAG]]);
    for (const n of r.notApplied) expect(n.message.startsWith(`${DUPLICATE_EQUIPMENT_TAG_REASON} (`)).toBe(true);
    expect(DUPLICATE_EQUIPMENT_TAG_REASON).toBe("duplicate equipment tag on this request — kept the first");
    expect(r.notApplied[0].message).toContain('the backup\'s "E22" was not restored');
    expect(restoreRefusalLabel(DUPLICATE_EQUIPMENT_TAG)).toContain(DUPLICATE_EQUIPMENT_TAG_REASON);
    // the restored rows land in this workspace under the reconciled person
    expect(((db.rows.ticket_equipment ?? []) as Row[]).every((x) => x.org_id === ORG && x.created_by === "new-req")).toBe(true);
  });

  it("a re-run writes nothing new and reports the same duplicates (the first entries are already here)", async () => {
    await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup });
    const again = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup });
    expect(again.ok).toBe(true);
    expect(again.refused).toEqual([]);
    expect(again.inserted).toBe(0);
    expect(again.existing).toBe(5);
    expect(again.notApplied.map((n) => n.id).sort()).toEqual(["e3", "e5"]);
    expect(listed()).toEqual(["t-1:E-22", "t-1:P-101", "t-2:E22"]);
  });

  it("a duplicate split across chunks (the first written by an earlier chunk) is skipped the same way", async () => {
    await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup.slice(0, 2) });
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup.slice(2) });
    expect(r).toMatchObject({ ok: true, refused: [], inserted: 1, existing: 2 });
    expect(r.notApplied.map((n) => n.id)).toEqual(["e3", "e5"]);
  });

  it("a first entry the database refuses for its own reason leaves the tag free: the backup's next spelling is written in its place, never both lost", async () => {
    refuseTag = "E-22";
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup });
    expect(r.ok).toBe(true);
    expect(r.refused.map((x) => [x.id, x.code])).toEqual([["e1", "23514"]]);
    expect(listed()).toEqual(["t-1:E22", "t-1:P-101", "t-2:E22"]);
    expect(r.notApplied.map((n) => n.id)).toEqual(["e5"]);
  });

  it("REGRESSION: before the paste (no index) the restore writes every row exactly as before — nothing skipped, nothing reported", async () => {
    indexPasted = false;
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_equipment", idRemap: remap, rows: backup });
    expect(r).toMatchObject({ ok: true, inserted: 5, existing: 0, refused: [], notApplied: [] });
    expect(db.attempts.filter((a) => a.table === "ticket_equipment")).toHaveLength(1);
  });

  it("REGRESSION: another table's 23505 is refused as before (the duplicate rule is ticket_equipment's index only)", async () => {
    db.keys = { subscriptions: [["id"], ["user_id", "resource_type", "resource_id"]] };
    db.rows.documents = [{ id: "doc-1", org_id: ORG }];
    db.writeError = (table) => (table === "subscriptions" ? { code: "23505", message: "duplicate key value violates unique constraint \"x\"" } : null);
    const r = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [{ id: "s1", org_id: "backup-org", user_id: "old-req", resource_type: "document", resource_id: "doc-1" }],
    });
    expect(r.refused.map((x) => x.code)).toEqual(["23505"]);
    expect(r.notApplied).toEqual([]);
  });
});
