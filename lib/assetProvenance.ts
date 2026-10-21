// lib/assetProvenance.ts — intelligence Round G I-32: GAP-303 acceptance 1 /
// GAP-316, "how we came to believe this". ONE per-asset view, on the asset
// hub, of every relation to the asset — the controlled documents
// (document_assets) and the knowledge-library uploads
// (knowledge_document_assets, 20261235) — with who or what asserted each
// (a person who linked it, a person's own equipment tags, the equipment
// sweep reading the drawing's text, or an AI transcription with its model and
// revision), when, and from which sheet / page; how the asset entered the
// registry (assets.origin / discovered_from); and each recorded decision that
// changed a link (the EQUIPMENT_BRIDGE_* audit rows).
//
// Pure assembly: GET /api/assets/provenance does the reads (as the caller,
// under their own RLS, with the I-12 read predicate on every controlled
// document) and hands the rows here. Nothing is stored and no score is shown:
// every line is a record that exists (GAP-316 "Do not").
//
// What the reader may not read is not here and not counted: the route passes
// only the documents and uploads the reader can read, and a link, a decision
// or a discovery source on anything else is dropped before assembly (the
// discovery says the source is not one they can open, naming nothing). A
// source the route could not read at all is said to be unread — never
// presented as an access verdict (DEC-90 ruling (1)).
//
// Agreement with the graph (GAP-303's graph remainder): machine-read vs
// person-asserted, and every sheet mark, come from lib/relationProvenance.ts —
// the functions the org graph's edges use — and "a person also tagged it" is
// decided by the asset's own tag against the document's equipment tags, as
// the graph decides it.

import { tagKey } from "@/lib/codebook";
import {
  assetTagsName, linkStandingOf, relationAsserter, sheetMarkOf, sheetReadingOf, type LinkStanding,
} from "@/lib/relationProvenance";

export interface ProvRelationRow {
  id?: string | null;
  document_id?: string | null;
  knowledge_document_id?: string | null;
  tag_text?: string | null;
  source?: string | null;
  sheet_label?: string | null;
  pages?: unknown;
  asserted_by?: string | null;
  asserted_by_user?: string | null;
  model?: string | null;
  source_revision?: string | null;
  vanished_at?: string | null;
  superseded_at?: string | null;
  created_at?: string | null;
}
export interface ProvDocumentRow {
  id: string; document_number?: string | null; title?: string | null; name?: string | null;
  status?: string | null; library_id?: string | null; asset_tags?: unknown;
}
export interface ProvKnowledgeRow { id: string; name?: string | null; library_id?: string | null }
export interface ProvAuditRow {
  id?: string | null; action: string; resource_type?: string | null; resource_id?: string | null;
  user_id?: string | null; details?: unknown; created_at?: string | null;
}
export interface ProvAssetRow {
  id: string; tag: string; origin?: string | null; discovered_from?: unknown; created_at?: string | null;
  /** The registry's accountable identity for the row (NOT NULL since
   *  20260603): the person who entered it, or — for the equipment sweep —
   *  the person who applied it, else the one who turned automatic apply on,
   *  else whoever filed the drawing (BR-8, lib/equipmentBridgeServer.ts). */
  created_by?: string | null;
}

/** The placeholder BR-8 writes when no accountable identity exists — never
 *  a person, never named. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The uid the registry records as the asset's creator, when it names one. */
export function assetCreatorUid(asset: Pick<ProvAssetRow, "created_by">): string | null {
  const u = typeof asset.created_by === "string" ? asset.created_by.trim() : "";
  return u && u !== NIL_UUID ? u : null;
}

/** The decisions the equipment sweep records (lib/equipmentBridgeServer.ts). */
export const BRIDGE_DECISION_ACTIONS = [
  "EQUIPMENT_BRIDGE_APPLIED",
  "EQUIPMENT_BRIDGE_DISMISSED",
  "EQUIPMENT_BRIDGE_RELATION_REMOVED",
  "EQUIPMENT_BRIDGE_VANISHED_REMOVED",
  "EQUIPMENT_BRIDGE_VANISHED_KEPT",
  "EQUIPMENT_BRIDGE_RELATION_ADOPTED",
  "EQUIPMENT_BRIDGE_DISCOVERED",
] as const;

/** The most relation rows each relation read takes; reaching it is said,
 *  and the links' section then shows no count (`linksCapped`). */
export const PROVENANCE_LINK_CAP = 1000;
/** The decision read pages back through the workspace's equipment-sweep
 *  decisions this many at a time, newest first … */
export const PROVENANCE_DECISION_PAGE = 1000;
/** … and searches at most this many; reaching it is said, and the
 *  decisions' section then shows no count and no "none" (`decisionsCapped`). */
export const PROVENANCE_DECISION_CAP = 5000;
/** GET /api/assets/provenance's 503 when the read predicate cannot decide. */
export const PROVENANCE_ACCESS_UNCHECKED =
  "Your document access couldn't be checked just now, so this equipment's story is not shown — rather than show links on documents that may not be yours to see. Try again in a moment.";

export interface ProvTarget { kind: "document" | "knowledge"; id: string; label: string; href: string | null; archived: boolean }

export interface ProvLink {
  key: string;
  target: ProvTarget;
  /** How the link reads (lib/relationProvenance linkStandingOf) — what the
   *  graph's edge says too. */
  standing: LinkStanding;
  /** Who or what asserted it, in words. */
  assertedBy: string;
  /** A person's link: who linked it ('manual' — asserted_by_user), when the
   *  name could be read. Never named for a tag-sync row: that uid is whoever
   *  last edited the document's equipment tags, not necessarily who typed
   *  this one (20261171's header). */
  personName: string | null;
  /** A machine's reading: the AI model that transcribed the page, else null
   *  (the PDF's own text layer). */
  model: string | null;
  revision: string | null;
  sheet: string | null;
  /** The sheet address's mark (AI-read / the sweep's, unconfirmed), or null. */
  sheetMark: string | null;
  pages: number[];
  vanished: boolean;
  superseded: boolean;
  at: string | null;
  /** What `at` is. "asserted": when the link was made (a machine's reading,
   *  a person's link, the adoption recorded by EQUIPMENT_BRIDGE_RELATION_ADOPTED).
   *  "first_recorded": a person's link adopted from the sweep whose adoption
   *  record was not read — the row's created_at is when the sweep first
   *  related the pair, not when the person linked it (GAP-303 acceptance 1). */
  atMeaning: "asserted" | "first_recorded";
}

export interface ProvDecision {
  key: string;
  action: string;
  words: string;
  actor: string;
  target: ProvTarget;
  detail: string | null;
  at: string | null;
}

/** How the asset entered the registry. `recordedBy` is the name of the
 *  person the registry records as its creator (`assets.created_by`), when it
 *  names one and the name could be read — a registry record, said as one.
 *  `person` rests on `assets.origin = 'manual'` alone, the column's DEFAULT
 *  (20260928) backfilled onto every older row, so it is said as what the
 *  registry records, never as a fact. */
export type ProvDiscovery =
  | { kind: "not_recorded"; recordedBy: string | null }
  | { kind: "person"; recordedBy: string | null }
  | {
      kind: "sweep"; door: "drawing" | "knowledge"; source: ProvTarget | null;
      /** The source is not one the reader may open (RLS or the I-12 predicate). */
      sourceHidden: boolean;
      /** The read that would list the source failed: said as unread, never as
       *  an access verdict. */
      sourceUnread: boolean;
      pages: number[]; sheets: Array<{ page: number | null; label: string; aiRead: boolean }>;
      revision: string | null; automatic: boolean; confirmedByPerson: boolean; recordedBy: string | null;
    };

export interface AssetProvenance {
  asset: { id: string; tag: string };
  discovery: ProvDiscovery;
  links: ProvLink[];
  decisions: ProvDecision[];
  /** Everything that could not be read, or was read only in part — said,
   *  never "none". */
  notes: string[];
  /** A read the links depend on failed (a relation read, or the documents /
   *  uploads it names): an empty list is NOT "no link" (DEC-90 ruling (1)). */
  linksIncomplete: boolean;
  /** A read the decisions depend on failed (the audit trail, or the
   *  documents / uploads it names): an empty list is NOT "no decision". */
  decisionsUnread: boolean;
  /** A relation read reached PROVENANCE_LINK_CAP: there may be more links
   *  than are listed, so the section shows no count. */
  linksCapped: boolean;
  /** The decision read reached PROVENANCE_DECISION_CAP: older decisions were
   *  not searched, so the section shows no count and no "none". */
  decisionsCapped: boolean;
  /** knowledge_document_assets is installed (20261235). */
  knowledgeRelationInstalled: boolean;
}

const pagesOf = (v: unknown): number[] => Array.isArray(v)
  ? [...new Set((v as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
  : [];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function docTarget(d: ProvDocumentRow): ProvTarget {
  return {
    kind: "document", id: d.id,
    label: String(d.document_number || d.title || d.name || "Document"),
    href: d.library_id ? `/documents/${d.library_id}?doc=${d.id}` : null,
    archived: d.status === "Archived",
  };
}
function knowledgeTarget(k: ProvKnowledgeRow): ProvTarget {
  return {
    kind: "knowledge", id: k.id, label: String(k.name || "Knowledge upload"),
    href: k.library_id ? `/knowledge/${k.library_id}?doc=${k.id}` : null, archived: false,
  };
}

function assertedWords(r: ProvRelationRow, standing: LinkStanding, personName: string | null, knowledge: boolean): string {
  if (standing !== "person") {
    const how = r.model ? `AI-read (${r.model})` : "read from drawing (the PDF's own text)";
    const where = knowledge ? "the knowledge upload" : "the drawing";
    const base = `The equipment sweep read it off ${where} — ${how}`;
    return standing === "machine_person_also"
      ? `${base}; a person also tagged the document with it (its equipment tags)`
      : `${base}; not typed by a person`;
  }
  if (r.source === "jsonb_sync") return "A person tagged the document with it (its equipment tags)";
  return personName ? `Linked by ${personName}` : "Linked by a person";
}

/** Do the audit row's details name this asset — by id, or by its tag in the
 *  one tag grammar? */
export function auditNamesAsset(details: unknown, asset: Pick<ProvAssetRow, "id">, key: string): boolean {
  if (!details || typeof details !== "object") return false;
  const d = details as Record<string, unknown>;
  if (d.assetId === asset.id) return true;
  const byTag = (v: unknown) => typeof v === "string" && tagKey(v) === key;
  for (const k of ["tags", "created", "existing", "untyped"]) {
    if (Array.isArray(d[k]) && (d[k] as unknown[]).some(byTag)) return true;
  }
  if (byTag(d.tag)) return true;
  for (const k of ["removed", "keptAsPersonsLink"]) {
    if (Array.isArray(d[k]) && (d[k] as Array<Record<string, unknown> | null>).some((e) => !!e && (e.assetId === asset.id || byTag(e.tag)))) return true;
  }
  return false;
}

function decisionWords(row: ProvAuditRow): { words: string; detail: string | null } {
  const d = (row.details && typeof row.details === "object" ? row.details : {}) as Record<string, unknown>;
  const rev = str(d.revision);
  const revText = rev ? `Rev ${rev}` : null;
  switch (row.action) {
    case "EQUIPMENT_BRIDGE_APPLIED":
      return { words: d.auto === true ? "Applied from the equipment sweep automatically" : "Applied from the equipment sweep", detail: revText };
    case "EQUIPMENT_BRIDGE_DISMISSED":
      return { words: "The sweep's reading was dismissed", detail: revText };
    case "EQUIPMENT_BRIDGE_RELATION_REMOVED": {
      const via = str(d.via);
      return { words: "The sweep's link was removed", detail: via === "column" ? "the tag column was re-mapped" : via === "review" ? "on review" : via };
    }
    case "EQUIPMENT_BRIDGE_VANISHED_REMOVED":
      return { words: "Removed: it had left the sheet on a later revision", detail: null };
    case "EQUIPMENT_BRIDGE_VANISHED_KEPT":
      return { words: "Kept: confirmed still on the sheet", detail: revText };
    case "EQUIPMENT_BRIDGE_RELATION_ADOPTED": {
      const sheet = str(d.sheet);
      const model = str(d.model);
      return {
        words: "Made a person's link (adopted from the sweep's reading)",
        detail: [sheet ? `${sheet}${model ? ` — read off an AI transcription (${model})` : ""}` : null, revText].filter(Boolean).join(", ") || null,
      };
    }
    case "EQUIPMENT_BRIDGE_DISCOVERED":
      return { words: "Discovered from a knowledge upload", detail: null };
    default:
      return { words: row.action, detail: null };
  }
}

export interface AssembleInput {
  asset: ProvAssetRow;
  documentRelations: ProvRelationRow[];
  knowledgeRelations: ProvRelationRow[];
  /** The documents the reader may read (RLS and the I-12 predicate), by id. */
  readableDocuments: ReadonlyMap<string, ProvDocumentRow>;
  /** The knowledge uploads the reader may read, by id. */
  readableKnowledge: ReadonlyMap<string, ProvKnowledgeRow>;
  audits: ProvAuditRow[];
  /** uid → display name (or email). */
  names: ReadonlyMap<string, string>;
  notes: string[];
  knowledgeRelationInstalled: boolean;
  /** See AssetProvenance — false when omitted. */
  linksIncomplete?: boolean;
  decisionsUnread?: boolean;
  linksCapped?: boolean;
  decisionsCapped?: boolean;
  /** The documents / knowledge-uploads read failed (false when omitted): a
   *  discovery source it would have listed is unread, not hidden. */
  documentsUnread?: boolean;
  knowledgeUnread?: boolean;
}

/** When a person adopted the sweep's pair on this document: the newest
 *  EQUIPMENT_BRIDGE_RELATION_ADOPTED decision on it naming this asset by id
 *  (adoptDrawingRelation records details.assetId), else null. */
function adoptedAt(audits: readonly ProvAuditRow[], documentId: string, assetId: string): string | null {
  let at: string | null = null;
  for (const a of audits) {
    if (a.action !== "EQUIPMENT_BRIDGE_RELATION_ADOPTED" || a.resource_type !== "document") continue;
    if (String(a.resource_id ?? "") !== documentId) continue;
    const d = a.details && typeof a.details === "object" ? a.details as Record<string, unknown> : null;
    if (!d || d.assetId !== assetId) continue;
    const t = str(a.created_at);
    if (t && (!at || t > at)) at = t;
  }
  return at;
}

const byTime = (a: { at: string | null; key: string }, b: { at: string | null; key: string }) =>
  (a.at ?? "￿").localeCompare(b.at ?? "￿") || a.key.localeCompare(b.key);

export function assembleAssetProvenance(input: AssembleInput): AssetProvenance {
  const { asset } = input;
  const key = tagKey(asset.tag);
  const keys = new Set(key ? [key] : []);
  const links: ProvLink[] = [];

  for (const r of input.documentRelations) {
    const d = r.document_id ? input.readableDocuments.get(String(r.document_id)) : undefined;
    if (!d) continue; // not readable: not shown, not counted
    const standing = linkStandingOf(r, assetTagsName(d.asset_tags, keys));
    const personName = standing === "person" && r.source === "manual" && r.asserted_by_user
      ? input.names.get(String(r.asserted_by_user)) ?? null : null;
    const reading = sheetReadingOf(r);
    // A person's link carrying the sweep's sheet was adopted: the row keeps
    // the sweep's created_at, so "when" is the adoption's own record.
    const adopted = standing === "person" && reading === "sweep";
    const adoptAt = adopted ? adoptedAt(input.audits, String(r.document_id), asset.id) : null;
    links.push({
      key: `d:${r.id ?? r.document_id}`,
      target: docTarget(d),
      standing,
      assertedBy: assertedWords(r, standing, personName, false),
      personName,
      model: standing === "person" ? null : str(r.model),
      revision: standing === "person" ? null : str(r.source_revision),
      sheet: str(r.sheet_label),
      sheetMark: sheetMarkOf(reading),
      pages: pagesOf(r.pages),
      vanished: !!r.vanished_at,
      superseded: !!r.superseded_at,
      at: adoptAt ?? str(r.created_at),
      atMeaning: adopted && !adoptAt ? "first_recorded" : "asserted",
    });
  }
  for (const r of input.knowledgeRelations) {
    const k = r.knowledge_document_id ? input.readableKnowledge.get(String(r.knowledge_document_id)) : undefined;
    if (!k) continue;
    // A knowledge upload carries no equipment tags of a person's: its rows
    // are the sweep's alone (20261235: a 'drawing' row is always a machine's).
    const facts = { ...r, source: r.source ?? "drawing" };
    const standing = relationAsserter(facts) === "machine" ? "machine" : "person";
    links.push({
      key: `k:${r.id ?? r.knowledge_document_id}`,
      target: knowledgeTarget(k),
      standing,
      assertedBy: assertedWords(facts, standing, null, true),
      personName: null,
      model: str(r.model),
      revision: str(r.source_revision),
      sheet: str(r.sheet_label),
      sheetMark: sheetMarkOf(sheetReadingOf(facts)),
      pages: pagesOf(r.pages),
      vanished: false,
      superseded: false,
      at: str(r.created_at),
      atMeaning: "asserted",
    });
  }
  links.sort(byTime);

  const decisions: ProvDecision[] = [];
  for (const a of input.audits) {
    if (!(BRIDGE_DECISION_ACTIONS as readonly string[]).includes(a.action)) continue;
    if (!auditNamesAsset(a.details, asset, key)) continue;
    const rid = String(a.resource_id ?? "");
    const target = a.resource_type === "document"
      ? (input.readableDocuments.get(rid) ? docTarget(input.readableDocuments.get(rid)!) : null)
      : a.resource_type === "knowledge_document"
        ? (input.readableKnowledge.get(rid) ? knowledgeTarget(input.readableKnowledge.get(rid)!) : null)
        : null;
    if (!target) continue; // a decision on something the reader cannot read is not shown
    const { words, detail } = decisionWords(a);
    const auto = (a.details as Record<string, unknown> | null)?.auto === true;
    decisions.push({
      key: `a:${a.id ?? `${a.action}:${rid}:${a.created_at}`}`,
      action: a.action,
      words,
      actor: a.user_id ? (input.names.get(String(a.user_id)) ?? "a person") : auto ? "the equipment sweep (automatic)" : "not recorded",
      target, detail, at: str(a.created_at),
    });
  }
  decisions.sort(byTime);

  return {
    asset: { id: asset.id, tag: asset.tag },
    discovery: discoveryOf(asset, input),
    links, decisions,
    notes: input.notes,
    linksIncomplete: input.linksIncomplete === true,
    decisionsUnread: input.decisionsUnread === true,
    linksCapped: input.linksCapped === true,
    decisionsCapped: input.decisionsCapped === true,
    knowledgeRelationInstalled: input.knowledgeRelationInstalled,
  };
}

function discoveryOf(asset: ProvAssetRow, input: AssembleInput): ProvDiscovery {
  const from = asset.discovered_from && typeof asset.discovered_from === "object"
    ? asset.discovered_from as Record<string, unknown> : null;
  const creator = assetCreatorUid(asset);
  const recordedBy = creator ? input.names.get(creator) ?? null : null;
  if (!from) {
    if (asset.origin === "manual") return { kind: "person", recordedBy };
    return { kind: "not_recorded", recordedBy };
  }
  const door = from.door === "knowledge" || (!from.documentId && from.knowledgeDocumentId) ? "knowledge" : "drawing";
  const sourceId = String((door === "knowledge" ? from.knowledgeDocumentId : from.documentId) ?? "");
  const doc = door === "drawing" ? input.readableDocuments.get(sourceId) : undefined;
  const kdoc = door === "knowledge" ? input.readableKnowledge.get(sourceId) : undefined;
  const source = doc ? docTarget(doc) : kdoc ? knowledgeTarget(kdoc) : null;
  const sheets = Array.isArray(from.sheets)
    ? (from.sheets as Array<Record<string, unknown> | null>).filter((x): x is Record<string, unknown> => !!x && typeof x.label === "string")
      .map((x) => ({ page: Number.isInteger(Number(x.page)) ? Number(x.page) : null, label: String(x.label), aiRead: x.aiRead === true }))
    : [];
  const sourceUnread = !source && !!sourceId
    && (door === "drawing" ? input.documentsUnread === true : input.knowledgeUnread === true);
  return {
    kind: "sweep", door, source, sourceHidden: !source && !!sourceId && !sourceUnread, sourceUnread,
    // Where on a source the reader cannot open is not said either.
    pages: source ? pagesOf(from.pages) : [],
    sheets: source ? sheets : [],
    revision: source ? str(from.revision) : null,
    automatic: from.auto === true,
    confirmedByPerson: asset.origin === "manual",
    recordedBy,
  };
}
