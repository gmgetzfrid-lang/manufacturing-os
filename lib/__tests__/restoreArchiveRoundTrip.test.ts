// lib/__tests__/restoreArchiveRoundTrip.test.ts
//
// admin-and-org Round G, package P1 — BKP-7 / BKP-10: ONE archive layout.
//
// The regression this package must not cause: a backup produced by the
// CURRENT export restores end to end. Each test builds a real archive with
// the real producers — lib/dataExport.ts runOrgExport (the envelope), then
// lib/clientBackup.ts runFullBackup (the browser-built Full ZIP, in parts)
// or lib/exportRunner.ts buildAndDeliverExport (the server ZIP) — reads it
// back with lib/dataRestore.ts readBackupArchive (what /admin/restore runs),
// and restores it through the real /begin + /apply-table routes into another
// workspace. A browser backup written BEFORE this change (data.json in part
// 1) still restores; a part set that cannot be restored is refused with a
// message, before anything is written.
//
// P1 fix pass: the engine enforces every FOREIGN KEY the census finds
// between restorable tables (23503 on an orphan, as Postgres does), and the
// source org carries the relationships the review named — a checkout session
// on an episode, a document in a set, a library with an owner team, a
// knowledge mention and an AI-read flow, a project whose SOW is a document,
// a hold and a milestone citing a ticket, a version that supersedes another,
// a sub-folder listed before its parent folder. A fresh-workspace restore of the current export
// must land every one of them, with no stop and no refusal.
//
// P1 fix pass 2: the engine also refuses a value for a GENERATED ALWAYS
// column (428C9, as Postgres does — the export carries knowledge_chunks.tsv
// and knowledge_questions.search_tsv) and models users.id REFERENCES
// auth.users: a restored placeholder gets no profile row, so a row naming
// it through a users foreign key is refused 23503 by the engine. The source
// org carries indexed knowledge (chunks, page entities, questions) and output
// templates after it, and a team CREATED BY a placeholder that owns the
// library everything else hangs off. Every one of them lands; the only
// outcomes are the placeholder's own: its team membership is refused
// (person_not_restored) and the team's creator / the adder are cleared.
//
// admin-and-org P2 (BKP-9): the export's file manifest now reads the storage-
// key registry, so the output template's .docx (KEY_T) is a file of the
// backup like the two revisions — three files, packed, put back, restored.
// lib/__tests__/exportContractRoundTrip.test.ts carries every registered
// binary and the org-less tables (BKP-4) through the same round trip.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { db, type Row } from "./helpers/restoreMemoryDb";
import { censusSchema } from "./helpers/schemaKeys";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@target.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});
vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return { createClient: () => ({ from: mem.from }) };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/pdf" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { runOrgExport, type DataExportEnvelope } from "@/lib/dataExport";
import { buildAndDeliverExport } from "@/lib/exportRunner";
import { runFullBackup, BACKUP_ARCHIVE_ENTRIES } from "@/lib/clientBackup";
import {
  readBackupArchive, planRestore, runChunkedRestore, remapOrgPath, RESTORE_CONTRACT_TABLES, isSkippedTable,
  type RestorePost, type BackupZipLike, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import { POST as applySingle } from "@/app/api/admin/restore/apply/route";

const SRC = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const KEY_A = `orgs/${SRC}/libraries/lib-1/P-101.pdf`;
const KEY_B = `orgs/${SRC}/libraries/lib-1/P-102.pdf`;
const KEY_T = `orgs/${SRC}/templates/ds.docx`;
const BYTES: Record<string, string> = { [KEY_A]: "AAAA", [KEY_B]: "BBBB", [KEY_T]: "TTTT" };

function seedSource() {
  db.rows = {
    orgs: [{ id: SRC, name: "Acme" }],
    org_members: [
      { org_id: SRC, uid: "u-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: SRC, uid: "u-bob", email: "bob@acme.com", role: "Engineer", roles: ["Engineer"], status: "active" },
    ],
    // created by bob, who is a placeholder in the target (no sign-in account there)
    teams: [{ id: "team-1", org_id: SRC, name: "Operations", created_by: "u-bob" }],
    team_members: [
      { team_id: "team-1", uid: "u-alice", org_id: SRC, added_by: "u-bob" },
      { team_id: "team-1", uid: "u-bob", org_id: SRC, added_by: "u-alice" },
    ],
    libraries: [{ id: "lib-1", org_id: SRC, name: "P&IDs", owner_team_id: "team-1" }],
    document_sets: [{ id: "set-1", org_id: SRC, library_id: "lib-1", name: "Unit 100" }],
    // a sub-folder the export lists BEFORE the folder it sits in
    collections: [
      { id: "col-sub", org_id: SRC, library_id: "lib-1", parent_id: "col-root", name: "Unit 100" },
      { id: "col-root", org_id: SRC, library_id: "lib-1", parent_id: null, name: "Area 1" },
    ],
    documents: [{ id: "doc-1", org_id: SRC, library_id: "lib-1", collection_id: "col-sub", set_id: "set-1", title: "P-101", created_by: "u-alice" }],
    document_versions: [
      { id: "v-1", org_id: SRC, record_id: "doc-1", revision_label: "A", file_url: KEY_A, size: 4, created_by: "u-bob" },
      { id: "v-2", org_id: SRC, record_id: "doc-1", revision_label: "B", file_url: KEY_B, size: 4, created_by: "u-bob", supersedes_version_id: "v-1" },
    ],
    projects: [{ id: "proj-1", org_id: SRC, name: "Turnaround", sow_document_id: "doc-1" }],
    tickets: [{ id: "tk-1", org_id: SRC, title: "Hold for HAZOP" }],
    document_holds: [{ id: "hold-1", org_id: SRC, document_id: "doc-1", origin_ticket_id: "tk-1", reason: "HAZOP" }],
    milestones: [{ id: "ms-1", org_id: SRC, project_id: "proj-1", linked_ticket_id: "tk-1", name: "IFC" }],
    checkout_episodes: [{ id: "ep-1", org_id: SRC, document_id: "doc-1", library_id: "lib-1", status: "closed" }],
    checkout_sessions: [{ id: "cs-1", org_id: SRC, document_id: "doc-1", library_id: "lib-1", episode_id: "ep-1" }],
    assets: [{ id: "as-1", org_id: SRC, library_id: "lib-1", tag: "P-101A" }],
    knowledge_libraries: [{ id: "kl-1", org_id: SRC, name: "Vendor manuals" }],
    knowledge_sources: [{ id: "ks-1", org_id: SRC, library_id: "kl-1" }],
    knowledge_documents: [{ id: "kd-1", org_id: SRC, library_id: "kl-1", source_id: "ks-1", source_document_id: "doc-1" }],
    entity_mentions: [{ id: "em-1", org_id: SRC, asset_id: "as-1", knowledge_document_id: "kd-1", page: 1 }],
    process_flows: [{ id: "pf-1", org_id: SRC, source_document_id: "kd-1" }],
    // indexed knowledge: the export carries the computed tsv / search_tsv columns
    knowledge_chunks: [{ id: "kc-1", org_id: SRC, library_id: "kl-1", document_id: "kd-1", page: 1, seq: 0, section: "Specs", content: "Pump P-101A", tsv: "'p-101a':3B 'pump':2B 'spec':1A" }],
    knowledge_page_entities: [{ id: "kpe-1", org_id: SRC, library_id: "kl-1", document_id: "kd-1", page: 1 }],
    knowledge_questions: [{ id: "kq-1", org_id: SRC, library_id: "kl-1", user_id: "u-alice", question: "Which pump?", answer: "P-101A", search_tsv: "'p-101a':3 'pump':2" }],
    output_templates: [{ id: "ot-1", org_id: SRC, name: "Datasheet", template_file_key: KEY_T }],
    output_generations: [{ id: "og-1", org_id: SRC, template_id: "ot-1" }],
    document_shares: [{ id: "sh-1", org_id: SRC, document_id: "doc-1", token: "live-share-token", revoked_at: null }],
    audit_logs: [],
  };
}
/** Every FOREIGN KEY between restorable tables and onto users, and every
 *  GENERATED ALWAYS column, as the database enforces them (census of supabase/). */
function enforceForeignKeys() {
  const schema = censusSchema();
  const restorable = new Set([...RESTORE_CONTRACT_TABLES].filter((t) => !isSkippedTable(t)));
  const fks: typeof db.fks = {};
  const generated: typeof db.generated = {};
  for (const t of restorable) {
    for (const f of schema.get(t)?.fks ?? []) {
      if (f.columns.length === 1 && (restorable.has(f.parent) || f.parent === "users")) (fks[t] ??= []).push({ column: f.columns[0], parent: f.parent });
    }
    const g = [...(schema.get(t)?.generated ?? [])];
    if (g.length) generated[t] = g;
  }
  expect(generated).toMatchObject({ knowledge_chunks: ["tsv"], knowledge_questions: ["search_tsv"] }); // sanity
  expect(fks.team_members).toContainEqual({ column: "uid", parent: "users" });
  db.fks = fks;
  db.generated = generated;
}
/** What the source org's backup carries that must land: table → ids. */
const RELATIONS: Record<string, string[]> = {
  teams: ["team-1"], libraries: ["lib-1"], collections: ["col-root", "col-sub"], document_sets: ["set-1"], documents: ["doc-1"], document_versions: ["v-1", "v-2"],
  projects: ["proj-1"], tickets: ["tk-1"], document_holds: ["hold-1"], milestones: ["ms-1"], checkout_episodes: ["ep-1"],
  checkout_sessions: ["cs-1"], assets: ["as-1"], knowledge_libraries: ["kl-1"], knowledge_sources: ["ks-1"],
  knowledge_documents: ["kd-1"], entity_mentions: ["em-1"], process_flows: ["pf-1"],
  knowledge_chunks: ["kc-1"], knowledge_page_entities: ["kpe-1"], knowledge_questions: ["kq-1"], output_templates: ["ot-1"], output_generations: ["og-1"],
};
function expectEveryRelationLanded() {
  for (const [table, ids] of Object.entries(RELATIONS)) {
    expect(rowsOf(table).map((r) => r.id).sort(), table).toEqual([...ids].sort());
    for (const r of rowsOf(table)) expect(r.org_id, `${table} ${String(r.id)}`).toBe(TARGET);
  }
  // alice is linked (she has a profile here); bob is a placeholder (none): his
  // membership cannot land, and the pointers naming him are cleared
  expect(rowsOf("team_members")).toEqual([expect.objectContaining({ team_id: "team-1", uid: "t-alice", org_id: TARGET, added_by: null })]);
  expect(rowsOf("teams")[0].created_by).toBeNull();
  expect(rowsOf("libraries")[0].owner_team_id).toBe("team-1"); // the team a placeholder created owns the library
  expect(rowsOf("checkout_sessions")[0].episode_id).toBe("ep-1");
  expect(rowsOf("entity_mentions")[0].knowledge_document_id).toBe("kd-1");
  // computed columns are never sent — the database recomputes them
  expect(rowsOf("knowledge_chunks")[0]).not.toHaveProperty("tsv");
  expect(rowsOf("knowledge_questions")[0]).not.toHaveProperty("search_tsv");
  expect(rowsOf("knowledge_questions")[0].user_id).toBe("t-alice");
  expect(rowsOf("output_templates")[0].template_file_key).toBe(`orgs/${TARGET}/templates/ds.docx`);
}
/** The only refusal / clears a fresh-workspace restore of this org may report: the placeholder's own. */
function expectOnlyPlaceholderOutcomes(tables: Array<{ name: string; refused?: Array<{ code: string }>; cleared?: Array<{ code: string; message: string }> }>) {
  const refused = tables.flatMap((t) => (t.refused ?? []).map((r) => `${t.name}:${r.code}`));
  expect(refused).toEqual(["team_members:person_not_restored"]);
  const cleared = tables.flatMap((t) => (t.cleared ?? []).map((r) => `${t.name}:${r.code}:${r.message.split(" ")[0]}`)).sort();
  expect(cleared).toEqual(["team_members:person_not_restored:added_by", "teams:person_not_restored:created_by"]);
}
function seedTarget() {
  db.rows = {
    orgs: [{ id: TARGET, name: "Acme" }],
    org_members: [{ org_id: TARGET, uid: "t-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    users: [{ id: "t-alice", email: "alice@acme.com" }, { id: "admin-1", email: "admin@target.io" }],
  };
  db.authUsers = new Set(["t-alice", "admin-1"]); // a placeholder uid is no sign-in account
  db.writes = []; db.attempts = [];
}

const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await (path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable)(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};

async function exportEnvelope(): Promise<DataExportEnvelope> {
  return runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com" });
}

/** Stub the browser's fetch: the structured-export endpoint and the presigned file URLs. */
function stubFetch(envelope: DataExportEnvelope, opts: { failKey?: string } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/data-export/structured")) return new Response(JSON.stringify(envelope), { status: 200 });
    const key = decodeURIComponent(url.replace("https://r2.test/", ""));
    if (key === opts.failKey) return new Response("gone", { status: 404 });
    if (BYTES[key]) return new Response(new TextEncoder().encode(BYTES[key]), { status: 200 });
    return new Response("missing", { status: 404 });
  }));
}

type Part = { name: string; zip: BackupZipLike & JSZip };
async function browserBackup(opts: { partCapBytes?: number; isCancelled?: () => boolean } = {}) {
  const saved: Array<{ name: string; bytes: Uint8Array }> = [];
  const result = await runFullBackup(SRC, {
    onProgress: () => undefined,
    save: async (blob, name) => { saved.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) }); },
    partCapBytes: opts.partCapBytes,
    isCancelled: opts.isCancelled,
  });
  const parts: Part[] = [];
  for (const s of saved) parts.push({ name: s.name, zip: (await JSZip.loadAsync(s.bytes)) as unknown as Part["zip"] });
  return { result, parts };
}
const entryNames = (p: Part) => Object.keys(p.zip.files).filter((n) => !p.zip.files[n].dir).sort();
const readJsonEntry = async (p: Part, name: string) => JSON.parse(await p.zip.file(name)!.async("string"));

async function restoreInto(envelope: RestoreEnvelopeLike) {
  const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
  return runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
}
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];

beforeEach(() => {
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false;
  db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  db.keys.team_members = [["team_id", "uid"]];
  seedSource();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("BKP-7 — the browser-built Full ZIP is written in the one layout and restores end to end", () => {
  it("part 1 carries manifest.json + tables/<table>.json (no data.json); every part carries files-manifest.json and backup-part.json", async () => {
    const envelope = await exportEnvelope();
    stubFetch(envelope);
    const { result, parts } = await browserBackup({ partCapBytes: 4 }); // one 4-byte file per part
    expect(result).toMatchObject({ parts: 3, filesPacked: 3, cancelled: false, filesTotal: 3, notAttempted: [] });
    expect(parts.map((p) => p.name)).toEqual([
      `backup-Acme-${envelope.manifest.exportedAt.slice(0, 10)}-part1.zip`,
      `backup-Acme-${envelope.manifest.exportedAt.slice(0, 10)}-part2.zip`,
      `backup-Acme-${envelope.manifest.exportedAt.slice(0, 10)}-part3.zip`,
    ]);
    const [p1, p2, p3] = parts;
    expect(entryNames(p1)).toContain(BACKUP_ARCHIVE_ENTRIES.manifest);
    expect(entryNames(p1)).toContain("tables/documents.json");
    expect(entryNames(p1)).toContain(`files/${KEY_A}`);
    expect(entryNames(p1)).not.toContain("data.json");
    expect(entryNames(p2)).toContain(`files/${KEY_B}`);
    expect(entryNames(p3)).toContain(`files/${KEY_T}`); // BKP-9: the template binary is in the backup
    expect(entryNames(p3)).toContain(BACKUP_ARCHIVE_ENTRIES.report);
    for (const p of parts) {
      expect(entryNames(p), p.name).toContain(BACKUP_ARCHIVE_ENTRIES.filesManifest);
      expect(entryNames(p), p.name).toContain(BACKUP_ARCHIVE_ENTRIES.part);
    }
    // the restore page's own patterns find them (ILIFE-3's round-trip check)
    expect(entryNames(p1).some((n) => /(^|\/)manifest\.json$/i.test(n))).toBe(true);
    expect(entryNames(p1).filter((n) => /(^|\/)tables\/[^/]+\.json$/i.test(n)).length).toBe(Object.keys(envelope.tables).length);
    // hashes in part 1 already (BKP-10), cumulative in the later parts
    expect(Object.keys(await readJsonEntry(p1, "files-manifest.json"))).toEqual([KEY_A]);
    expect(Object.keys(await readJsonEntry(p2, "files-manifest.json")).sort()).toEqual([KEY_A, KEY_B]);
    expect(Object.keys(await readJsonEntry(p3, "files-manifest.json")).sort()).toEqual([KEY_A, KEY_B, KEY_T].sort());
  });

  it("every part dropped together: records restore into another workspace and every file is found for 'Put the files back'", async () => {
    const envelope = await exportEnvelope();
    stubFetch(envelope);
    const { parts } = await browserBackup({ partCapBytes: 4 });
    const read = await readBackupArchive([...parts].reverse()); // any drop order
    expect(read.layout).toBe("manifest+tables");
    expect(read.recordsPart).toMatch(/part1\.zip$/);
    expect(read.warnings).toEqual([]);
    expect(read.files.map((f) => f.key).sort()).toEqual([KEY_A, KEY_B, KEY_T].sort());
    expect(remapOrgPath(read.files[0].key, [[SRC, TARGET]])).toMatch(new RegExp(`^orgs/${TARGET}/`));

    seedTarget();
    enforceForeignKeys();
    const result = await restoreInto(read.envelope);
    expect(result.stoppedAt).toBeNull();
    expect(result).toMatchObject({ totalRefused: 1, totalCleared: 2, totalHeldElsewhere: 0, totalExisting: 0, placeholdersWithoutProfile: 1 });
    expectOnlyPlaceholderOutcomes(result.tables);
    expect(result.idRemap.orgId).toEqual({ [SRC]: TARGET }); // what "Put the files back" remaps keys with
    expect(result.totalInserted).toBeGreaterThanOrEqual(5);
    expectEveryRelationLanded();
    expect(rowsOf("documents")).toEqual([expect.objectContaining({ id: "doc-1", org_id: TARGET, created_by: "t-alice" })]);
    expect(rowsOf("document_versions").map((v) => v.file_url).sort()).toEqual([
      `orgs/${TARGET}/libraries/lib-1/P-101.pdf`, `orgs/${TARGET}/libraries/lib-1/P-102.pdf`,
    ]);
    expect(String(rowsOf("document_shares")[0].token)).toMatch(/^restored-/);
    // bob is new to the target: an inactive placeholder, and his uid is remapped onto the versions
    const bob = rowsOf("org_members").find((m) => m.email === "bob@acme.com");
    expect(bob).toMatchObject({ status: "inactive", org_id: TARGET });
    expect(rowsOf("document_versions").every((v) => v.created_by === bob?.uid)).toBe(true);
  });

  it("the server ZIP (lib/exportRunner.ts) reads through the same reader and restores the same way", async () => {
    stubFetch(await exportEnvelope());
    seedSource();
    const out = await buildAndDeliverExport({
      supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com",
      includeFiles: true, delivery: { kind: "inline" },
    });
    const zip = (await JSZip.loadAsync(out.zipBytes!)) as unknown as Part["zip"];
    const read = await readBackupArchive([{ name: "manufacturing-os-backup.zip", zip }]);
    expect(read.layout).toBe("manifest+tables");
    expect(read.files.map((f) => f.key).sort()).toEqual([KEY_A, KEY_B, KEY_T].sort());
    seedTarget();
    enforceForeignKeys();
    const result = await restoreInto(read.envelope);
    expect(result.stoppedAt).toBeNull();
    expectOnlyPlaceholderOutcomes(result.tables);
    expect(rowsOf("documents")[0]).toMatchObject({ id: "doc-1", org_id: TARGET });
    expectEveryRelationLanded();
  });

  it("the single-shot /apply restores the same envelope too", async () => {
    const envelope = await exportEnvelope();
    seedTarget();
    enforceForeignKeys();
    const res = await applySingle(new NextRequest(`https://app/api/admin/restore/apply?orgId=${TARGET}`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ envelope, confirm: true }),
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failedTables).toEqual([]);
    expectOnlyPlaceholderOutcomes(body.tables);
    expect(body.placeholdersWithoutProfile).toBe(1);
    expect(String(body.note)).toMatch(/1 of them have no sign-in account yet/);
    expect(rowsOf("document_versions")).toHaveLength(2);
    expectEveryRelationLanded();
  });
});

describe("BKP-7 — an archive written before this change, and archives that cannot be restored", () => {
  /** The browser layout before admin-and-org P1: the whole envelope as data.json in part 1, hashes only in the last part. */
  async function legacyParts(envelope: DataExportEnvelope): Promise<Part[]> {
    const p1 = new JSZip();
    p1.file("data.json", JSON.stringify(envelope, null, 2));
    p1.file(`files/${KEY_A}`, BYTES[KEY_A]);
    const p2 = new JSZip();
    p2.file(`files/${KEY_B}`, BYTES[KEY_B]);
    p2.file("files-manifest.json", JSON.stringify({ [KEY_A]: { sha256: "x", size: 4, part: 1 }, [KEY_B]: { sha256: "y", size: 4, part: 2 } }));
    p2.file("backup-report.json", JSON.stringify({ exportedAt: envelope.manifest.exportedAt, parts: ["p1", "p2"], filesPacked: 2, errors: [] }));
    const load = async (z: JSZip) => (await JSZip.loadAsync(await z.generateAsync({ type: "uint8array" }))) as unknown as Part["zip"];
    return [{ name: "backup-Acme-old-part1.zip", zip: await load(p1) }, { name: "backup-Acme-old-part2.zip", zip: await load(p2) }];
  }

  it("an older browser backup (data.json) still restores, records and files", async () => {
    const parts = await legacyParts(await exportEnvelope());
    const read = await readBackupArchive(parts);
    expect(read.layout).toBe("data.json");
    expect(read.files.map((f) => f.key).sort()).toEqual([KEY_A, KEY_B]);
    seedTarget();
    enforceForeignKeys();
    const result = await restoreInto(read.envelope);
    expect(result.stoppedAt).toBeNull();
    expectOnlyPlaceholderOutcomes(result.tables);
    expect(rowsOf("document_versions")).toHaveLength(2);
    expectEveryRelationLanded();
  });

  it("a set with no records part, two backups' records, parts of different backups, or a damaged table is refused before anything is written", async () => {
    const envelope = await exportEnvelope();
    const legacy = await legacyParts(envelope);
    await expect(readBackupArchive([legacy[1]])).rejects.toThrow(/None of the dropped files carries the backup's records .*Drop part 1/);
    await expect(readBackupArchive([legacy[0], legacy[0]])).rejects.toThrow(/More than one backup's records were dropped/);

    stubFetch(envelope);
    const { parts } = await browserBackup({ partCapBytes: 4 });
    const other = new JSZip();
    other.file("backup-part.json", JSON.stringify({ orgId: SRC, exportedAt: "2020-01-01T00:00:00.000Z", part: 2 }));
    other.file("files/orgs/x/y.pdf", "Z");
    const otherZip = (await JSZip.loadAsync(await other.generateAsync({ type: "uint8array" }))) as unknown as Part["zip"];
    await expect(readBackupArchive([parts[0], { name: "old-part2.zip", zip: otherZip }])).rejects.toThrow(/belongs to a different backup/);

    const damaged = new JSZip();
    damaged.file("manifest.json", JSON.stringify(envelope.manifest));
    damaged.file("tables/documents.json", "[{ not json");
    const damagedZip = (await JSZip.loadAsync(await damaged.generateAsync({ type: "uint8array" }))) as unknown as Part["zip"];
    await expect(readBackupArchive([{ name: "damaged.zip", zip: damagedZip }])).rejects.toThrow(/tables\/documents\.json is unreadable — this archive is damaged\. Nothing was restored\./);

    // a user file named manifest.json inside files/ is never taken for the records
    const sneaky = new JSZip();
    sneaky.file("files/orgs/x/manifest.json", JSON.stringify({ orgId: "evil" }));
    const sneakyZip = (await JSZip.loadAsync(await sneaky.generateAsync({ type: "uint8array" }))) as unknown as Part["zip"];
    await expect(readBackupArchive([{ name: "sneaky.zip", zip: sneakyZip }])).rejects.toThrow(/None of the dropped files carries/);
  });

  it("a missing part is named, so the admin knows which files will not be put back", async () => {
    stubFetch(await exportEnvelope());
    const { parts } = await browserBackup({ partCapBytes: 4 });
    const read = await readBackupArchive([parts[0]]);
    expect(read.files.map((f) => f.key)).toEqual([KEY_A]);
    expect(read.warnings.join(" ")).toMatch(/The backup lists 3 file\(s\); the dropped part\(s\) carry 1\./);
    // with both parts there is no shortfall
    expect((await readBackupArchive(parts)).warnings).toEqual([]);
  });
});

describe("BKP-10 — a cancelled or partial backup says so in the archive itself", () => {
  it("cancelled: the last part is …-INCOMPLETE.zip and its report records cancelled, filesTotal and the files never attempted — never 'Every file verified'", async () => {
    stubFetch(await exportEnvelope());
    let attempted = 0;
    const { result, parts } = await browserBackup({ isCancelled: () => attempted++ >= 1 });
    expect(result).toMatchObject({ cancelled: true, filesTotal: 3, filesPacked: 1, notAttempted: [KEY_B, KEY_T] });
    const last = parts[parts.length - 1];
    expect(last.name).toMatch(/-part1-INCOMPLETE\.zip$/);
    const report = await readJsonEntry(last, "backup-report.json");
    expect(report).toMatchObject({ cancelled: true, filesTotal: 3, filesPacked: 1, notAttempted: [KEY_B, KEY_T], complete: expect.any(Boolean) });
    expect(Array.isArray(report.manifestNotes)).toBe(true);
    expect(report.note).toMatch(/^INCOMPLETE — the backup was cancelled after 1 of 3 file\(s\)/);
    expect(report.note).not.toMatch(/Every file verified/);
    // the restore page warns from the report
    const read = await readBackupArchive(parts);
    expect(read.warnings.join(" ")).toMatch(/CANCELLED before every file was packed: 2 file\(s\) are in no part/);
  });

  it("a failed file: the note names the gap; a clean run alone says every file is verified, and the report carries manifest.complete / notes", async () => {
    const envelope = await exportEnvelope();
    stubFetch(envelope, { failKey: KEY_B });
    const failed = await browserBackup();
    const r1 = await readJsonEntry(failed.parts[0], "backup-report.json");
    expect(r1.errors).toEqual([{ path: KEY_B, error: "HTTP 404" }]);
    expect(r1.note).toMatch(/Files listed under errors are NOT in this backup/);
    stubFetch(envelope);
    const clean = await browserBackup();
    const r2 = await readJsonEntry(clean.parts[0], "backup-report.json");
    expect(r2).toMatchObject({ cancelled: false, filesTotal: 3, filesPacked: 3, notAttempted: [], complete: envelope.manifest.complete, manifestNotes: envelope.manifest.notes });
    expect(r2.note).toBe("Every file verified by SHA-256 in files-manifest.json.");
  });
});

describe("BKP-7 — /admin/restore takes every part of one backup", () => {
  it("the page reads dropped ZIPs through readBackupArchive (several at once) and puts back every part's files", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toMatch(/const read = await readBackupArchive\(loaded\);/);
    expect(page).toMatch(/<input ref=\{inputRef\} type="file" multiple /);
    expect(page).toMatch(/const dropped = Array\.from\(e\.dataTransfer\.files \?\? \[\]\);/);
    expect(page).toMatch(/const blob = await zips\[item\.zip\]\.file\(item\.entry\)!\.async\("blob"\);/);
    expect(page).toMatch(/idRemapRef\.current = result\.idRemap;/);
    // the old single-layout gate is gone
    expect(page).not.toMatch(/No manifest\.json — this doesn't look like a manufacturing-os backup ZIP/);
  });
});
