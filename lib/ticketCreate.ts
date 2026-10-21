// lib/ticketCreate.ts
//
// drafting-flow Round G, DF-P2 CREATE — ONE field contract for every door
// that files a drafting request, and the pure checks /api/tickets/create
// applies to it.
//
// Three doors file a request: the request form (app/(protected)/requests/new),
// a document check-in (components/documents/CheckInPanel.tsx) and an intake
// collision (lib/transitionIn.ts flagCollisionToDrafting). Each used to
// assemble its own row in the browser, insert it under the requester's
// session and fan the notification out from the tab (FRIC-8 / LIFE-9:
// three creators, three field contracts; EDGE-8: a fan-out that dies with the
// tab). Now each one describes the request in THIS shape and posts it to the
// route, which validates it, allocates the request number only once it is
// valid (EDGE-13), inserts the row under the service role with the
// requester's identity stamped from their membership (replicating
// 20261038's ticket_insert_integrity, which a service-role insert bypasses),
// and fans out server-side (EDGE-1 / ROUTE-4 / ROUTE-11).
//
// The contract, field by field:
//   * title, description   required, plain text.
//   * requestType          one of the workspace's configured request types,
//                          or the check-in / transition-in vocabulary
//                          (Revision / ASBUILT / RFI) — 20261038's rule;
//                          free vocabulary for a workspace with no list.
//   * unit                 OPTIONAL (FRIC-3 / DCW-7). null is the explicit
//                          "Unit unknown — triage assigns" answer, never a
//                          dead end. Resolved against the workspace's unit
//                          list (or the Site Codebook's units) where one
//                          exists; derived from the source document when the
//                          requester leaves it unknown.
//   * priority, targetCompletionAt   the request form's fields; the SLA
//                          default per type when no date is given.
//   * customCategories     the admin-defined sections; the request form's
//                          required fields are re-checked server-side for
//                          the form's own origin ("portal"). The other two
//                          origins have no form: the route checks each one
//                          against its own facts instead (a check-in names a
//                          checkout of the document by this requester; a
//                          collision names an intake sheet in a project's
//                          intake folder, and that project's intake link).
//   * sourceDocuments      the controlled documents the request is raised
//                          against, primary first (HAND-7 captures each
//                          one's version; GAP-8 keeps every one, up to
//                          MAX_SOURCE_DOCUMENTS — an advisory hand-off: the
//                          sheets past it are dropped with a warning, never a
//                          refusal). Each is read AS THE CALLER: a document
//                          they cannot see is treated like one that is not
//                          in the workspace.
//   * attachments          files the requester staged under their pending
//                          prefix (never uploaded before the form's own
//                          checks pass — contractLimitRefusal included),
//                          plus a Source reference to a library file (an
//                          advisory hand-off: one the route cannot use is
//                          dropped with a warning, never a refusal).
//   * origin               which door, with that door's own facts.
//   * localYear            the requester's own calendar year (the browser's
//                          clock — lib/ticketCreateClient.ts adds it): the
//                          year the request number carries, when it is the
//                          year somewhere on Earth right now; else the
//                          server's UTC year (requestNumberYear).
//   * declaration          GAP-110 / DEC-33 / DEC-34 (DF-P6) — OPTIONAL: the
//                          requester's like-in-kind declaration, a sentence
//                          they composed (at least LIKE_IN_KIND_MIN_CHARS),
//                          signed through /api/signatures/sign against the
//                          request's own id (`ticketKey`, minted by the
//                          browser before filing). Absent / null = no
//                          declaration: the request is engineered work
//                          (engineering_required defaults true). Blank never
//                          blocks submission; a declaration that is present
//                          but malformed is refused with the reason.
//   * equipment            GAP-312 / WIRE-7 criterion 1 (DF-P6) — OPTIONAL:
//                          the equipment tags the request names, each with
//                          the asset the request form resolved it to (or
//                          none). The route keeps an asset only when it is
//                          one of this workspace's; a tag that resolves to
//                          nothing is kept as typed and flagged.
//   * The check-in's metadata.moc / minor_correction / undocumented_change
//     stay INFORMATIONAL records of what the check-in said (GAP-110
//     acceptance 5): no authority decision reads them. The engineering
//     requirement is tickets.engineering_required; the minor-correction
//     class is declared at approval (approve_minor_correction, TIER-7);
//     undocumented_change drives only the PSM escalation notice (LIFE-7).
//   * projectId            DEC-40 seam — tickets.project_id (DF-P8) is one
//                          more optional field. Read and IGNORED until DF-P8.

import type { OrgDraftingSettings } from "@/types/schema";
import { checkDeclarationStatement } from "@/lib/reviewModel";
import type { SourceDocumentRefRow } from "@/lib/sourceDocRef";

/** The explicit answer for a requester who does not know the unit. */
export const UNIT_UNKNOWN_LABEL = "Unit unknown — triage assigns";

/** 20261038 ticket_insert_integrity: the check-in / transition-in vocabulary
 *  accepted whatever the workspace configured. */
export const BUILTIN_REQUEST_TYPES: readonly string[] = ["Revision", "ASBUILT", "RFI"];

export const MAX_TITLE = 500;
export const MAX_DESCRIPTION = 20_000;
/** The most source documents one request keeps (GAP-8) — one per attachable
 *  file. A hand-off naming more keeps the first ones and says so; the list
 *  is advisory and never refuses the request (DEC-101 item 5). */
export const MAX_SOURCE_DOCUMENTS = 200;
/** An intake collision's overlap list as stored in metadata.intake_collision
 *  — far past what the impact scan reads (it reads at most 50 overlapping
 *  documents). A longer list is stored up to here with its full count and a
 *  truncated flag, never silently cut. */
export const MAX_COLLISION_OVERLAPS = 1000;
export const MAX_OVERLAP_TAGS = 500;
/** Generous: a walkdown can carry dozens of photos (nothing capped them
 *  before DF-P2). The form and the check-in check it before staging. */
export const MAX_ATTACHMENTS = 200;
/** A generous bound on the custom-category blob (JSON text). */
export const MAX_CUSTOM_JSON = 50_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CheckinMoc = { status: "completed" | "in_progress" | "none" | null; number: string | null };

export type TicketCreateOrigin =
  | { kind: "portal" }
  | {
      kind: "checkin";
      episodeId: string | null;
      checkoutNumber: number | null;
      purpose: string | null;
      outcome: string;
      moc: CheckinMoc | null;
      minorCorrection: boolean;
      undocumentedChange: boolean;
    }
  | {
      kind: "intake_collision";
      projectId: string;
      intakeLinkId: string | null;
      numberCollisionDocId: string | null;
      overlaps: Array<{ id: string; label: string; sharedTags: string[] }>;
      /** Set by parseTicketCreateBody (a producer never sends it): how many
       *  overlaps the producer reported — `overlaps` holds at most
       *  MAX_COLLISION_OVERLAPS of them. */
      overlapsTotal?: number;
      /** Set by parseTicketCreateBody: true when the stored list is shorter
       *  than the reported one (too many overlaps, or an overlap with too
       *  many shared tags). */
      overlapsTruncated?: boolean;
      /** The producer's label. The route replaces it with the intake sheet's
       *  own number once it has checked the sheet (the notice title is never
       *  the client's text). */
      sheetLabel: string;
    };

/** GAP-110 / DEC-34 (DF-P6): the declaration as the request form sends it —
 *  the statement as typed, the e-signature minted over it, and the id the
 *  request is filed under (the signature's resource). */
export interface TicketCreateDeclaration {
  statement: string;
  signatureId: string;
  ticketKey: string;
}

/** GAP-312 (DF-P6): one equipment tag the request names. */
export interface TicketCreateEquipment {
  tag: string;
  assetId: string | null;
}

/** The most equipment tags one request names. */
export const MAX_EQUIPMENT = 25;
export const MAX_EQUIPMENT_TAG = 80;

export interface TicketCreateSourceDoc {
  id: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  /** The version the producer saw (CheckInPanel: the document's current
   *  version at check-in). Kept only when it is a version of this document. */
  versionId: string | null;
}

export type TicketCreateAttachment =
  /** A file the requester staged under their pending prefix (EDGE-13). */
  | { kind: "staged"; key: string; name: string }
  /** A reference to a file already in the library (the viewer's "send to
   *  drafting"): attached as a Source, never copied. */
  | { kind: "source_reference"; key: string; name: string };

export interface TicketCreateInput {
  orgId: string;
  title: string;
  description: string;
  requestType: string;
  priority: number;
  /** null = UNIT_UNKNOWN_LABEL. */
  unit: string | null;
  targetCompletionAt: string | null;
  /** The role the requester files under; kept only if they hold it. */
  requesterRole: string | null;
  customCategories: Record<string, Record<string, unknown>> | null;
  sourceDocuments: TicketCreateSourceDoc[];
  attachments: TicketCreateAttachment[];
  origin: TicketCreateOrigin;
  /** GAP-110 / DEC-34 (DF-P6): the like-in-kind declaration, when made. */
  declaration?: TicketCreateDeclaration | null;
  /** GAP-312 (DF-P6): equipment the request names (never required). */
  equipment?: TicketCreateEquipment[];
  /** DEC-40 seam (DF-P8): ignored by this package. */
  projectId?: string | null;
  /** The requester's calendar year, from their own clock (null when the
   *  body did not carry a usable one) — see requestNumberYear. */
  localYear: number | null;
}

/** A refusal names the field it is about, so the form can move focus to it. */
export type ContractRefusal = { ok: false; field: string; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};
const refuse = (field: string, error: string): ContractRefusal => ({ ok: false, field, error });

/** The contract's size limits, in the words every door shows. The request
 *  form and the check-in run this BEFORE they stage a file (EDGE-13), and
 *  parseTicketCreateBody runs it again — the same rule, the same message. */
export function contractLimitRefusal(p: {
  title?: string | null;
  description?: string | null;
  attachmentCount?: number;
}): ContractRefusal | null {
  if ((p.title?.trim().length ?? 0) > MAX_TITLE) {
    return refuse("title", `The title is longer than ${MAX_TITLE} characters — shorten it.`);
  }
  if ((p.description?.trim().length ?? 0) > MAX_DESCRIPTION) {
    return refuse("description", `The description is longer than ${MAX_DESCRIPTION.toLocaleString("en-US")} characters — shorten it.`);
  }
  if ((p.attachmentCount ?? 0) > MAX_ATTACHMENTS) {
    return refuse("attachments", `At most ${MAX_ATTACHMENTS} files can be attached to one request — remove some, and attach the rest once it is filed.`);
  }
  return null;
}

/** A machine-written title or description (a check-in's, an intake
 *  collision's) is clipped to the contract's limit rather than refused —
 *  the requester did not type it and could not shorten it. */
export function clipToLimit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** GAP-8: a source-document list cut to MAX_SOURCE_DOCUMENTS, primary
 *  first — the form applies it before staging, the route when it parses. */
export function capSourceDocuments<T>(list: readonly T[]): { kept: T[]; dropped: number } {
  return { kept: list.slice(0, MAX_SOURCE_DOCUMENTS), dropped: Math.max(0, list.length - MAX_SOURCE_DOCUMENTS) };
}

/** The words for sheets a request could not keep (advisory, never a refusal). */
export function droppedSourceDocumentsWarning(dropped: number): string {
  return `${dropped} more linked document${dropped === 1 ? " was" : "s were"} not kept — one request links at most ${MAX_SOURCE_DOCUMENTS} (the first ${MAX_SOURCE_DOCUMENTS} are linked).`;
}

/** The year a request number carries. The requester's own calendar year
 *  (`localYear`, from their clock) when it is the calendar year somewhere on
 *  Earth right now — UTC−12 to UTC+14 — so a request filed at 19:00 on
 *  31 December in Texas is numbered in the year it was filed, not in the
 *  next one (the server's clock is UTC). Anything else (no year, a forged
 *  one) gets the server's UTC year: a body can never spend another year's
 *  counter. */
export function requestNumberYear(nowMs: number, localYear: number | null | undefined): number {
  const utc = new Date(nowMs).getUTCFullYear();
  if (typeof localYear !== "number" || !Number.isInteger(localYear)) return utc;
  const earliest = new Date(nowMs - 12 * 3_600_000).getUTCFullYear();
  const latest = new Date(nowMs + 14 * 3_600_000).getUTCFullYear();
  return localYear === earliest || localYear === latest ? localYear : utc;
}

/** Parse and shape-check a request body against the contract. Pure: what the
 *  workspace has configured is checked by the route. `warnings` names what an
 *  advisory part of the body lost (sheets past MAX_SOURCE_DOCUMENTS). */
export function parseTicketCreateBody(raw: unknown): { ok: true; input: TicketCreateInput; warnings: string[] } | ContractRefusal {
  if (!isObj(raw)) return refuse("body", "The request body must be a JSON object.");
  const orgId = text(raw.orgId);
  if (!orgId || !UUID_RE.test(orgId)) return refuse("orgId", "No workspace selected.");

  const title = text(raw.title);
  if (!title) return refuse("title", "A title is required.");
  const description = text(raw.description);
  if (!description) return refuse("description", "A description of the work is required.");
  const tooLong = contractLimitRefusal({ title, description });
  if (tooLong) return tooLong;

  const requestType = text(raw.requestType);
  if (!requestType) return refuse("requestType", "A request type is required.");

  let priority = 3;
  if (raw.priority != null) {
    const p = Number(raw.priority);
    if (!Number.isInteger(p) || p < 0 || p > 99) return refuse("priority", "The priority is not a valid choice.");
    priority = p;
  }

  if (raw.unit != null && typeof raw.unit !== "string") return refuse("unit", "The unit is not valid.");
  const unit = text(raw.unit);
  if (unit && unit.length > 120) return refuse("unit", "The unit is longer than 120 characters.");

  let targetCompletionAt: string | null = null;
  if (raw.targetCompletionAt != null && raw.targetCompletionAt !== "") {
    const t = typeof raw.targetCompletionAt === "string" ? Date.parse(raw.targetCompletionAt) : NaN;
    if (!Number.isFinite(t)) return refuse("targetCompletionAt", "The target completion date is not a date.");
    targetCompletionAt = new Date(t).toISOString();
  }

  const requesterRole = text(raw.requesterRole);

  let customCategories: Record<string, Record<string, unknown>> | null = null;
  if (raw.customCategories != null) {
    if (!isObj(raw.customCategories)) return refuse("customCategories", "The custom fields are not valid.");
    const out: Record<string, Record<string, unknown>> = {};
    for (const [cat, vals] of Object.entries(raw.customCategories)) {
      if (!isObj(vals)) return refuse("customCategories", "The custom fields are not valid.");
      out[cat] = vals;
    }
    let json = "";
    try { json = JSON.stringify(out); } catch { return refuse("customCategories", "The custom fields are not valid."); }
    if (json.length > MAX_CUSTOM_JSON) return refuse("customCategories", "The custom fields are too large.");
    customCategories = Object.keys(out).length > 0 ? out : null;
  }

  const warnings: string[] = [];
  let sourceDocuments: TicketCreateSourceDoc[] = [];
  if (raw.sourceDocuments != null) {
    if (!Array.isArray(raw.sourceDocuments)) return refuse("sourceDocuments", "The source documents are not valid.");
    const seen = new Set<string>();
    for (const d of raw.sourceDocuments) {
      if (!isObj(d)) return refuse("sourceDocuments", "The source documents are not valid.");
      const id = text(d.id);
      if (!id || !UUID_RE.test(id)) return refuse("sourceDocuments", "A source document reference is not valid.");
      if (seen.has(id)) continue;
      seen.add(id);
      const versionId = text(d.versionId);
      sourceDocuments.push({
        id,
        documentNumber: text(d.documentNumber),
        title: text(d.title),
        rev: text(d.rev),
        versionId: versionId && UUID_RE.test(versionId) ? versionId : null,
      });
    }
    // GAP-8 / DEC-101 item 5: the sheet list is advisory — the first
    // MAX_SOURCE_DOCUMENTS are kept, the rest dropped with a warning.
    const capped = capSourceDocuments(sourceDocuments);
    sourceDocuments = capped.kept;
    if (capped.dropped > 0) warnings.push(droppedSourceDocumentsWarning(capped.dropped));
  }

  const attachments: TicketCreateAttachment[] = [];
  if (raw.attachments != null) {
    if (!Array.isArray(raw.attachments)) return refuse("attachments", "The attachments are not valid.");
    const tooMany = contractLimitRefusal({ attachmentCount: raw.attachments.length });
    if (tooMany) return tooMany;
    for (const a of raw.attachments) {
      if (!isObj(a)) return refuse("attachments", "An attachment is not valid.");
      const key = text(a.key);
      const name = text(a.name);
      if (!key || !name || name.length > 255) return refuse("attachments", "An attachment is not valid.");
      if (a.kind === "staged") attachments.push({ kind: "staged", key, name });
      else if (a.kind === "source_reference") attachments.push({ kind: "source_reference", key, name });
      else return refuse("attachments", "An attachment is not valid.");
    }
  }

  const origin = parseOrigin(raw.origin);
  if (!origin) return refuse("origin", "Where the request comes from is not valid.");

  const localYear = typeof raw.localYear === "number" && Number.isInteger(raw.localYear) ? raw.localYear : null;

  const input: TicketCreateInput = {
    orgId, title, description, requestType, priority, unit, targetCompletionAt, requesterRole,
    customCategories, sourceDocuments, attachments, origin, localYear,
  };
  // GAP-110 / DEC-34 (DF-P6): the declaration — absent / null is no
  // declaration (the engineered lane); present, it must be the statement,
  // its signature and the id the request is filed under. The statement's
  // own rule (length, no canned text) is lib/reviewModel.ts's.
  if (raw.declaration !== undefined && raw.declaration !== null) {
    const d = raw.declaration;
    if (!isObj(d)) return refuse("declaration", "The like-in-kind declaration is not valid — write it again, or leave it blank.");
    const checked = checkDeclarationStatement(d.statement);
    if (!checked.ok) return refuse("declaration", checked.error);
    const signatureId = text(d.signatureId);
    const ticketKey = text(d.ticketKey);
    if (!signatureId || !UUID_RE.test(signatureId) || !ticketKey || !UUID_RE.test(ticketKey)) {
      return refuse("declaration", "The like-in-kind declaration needs your signature — sign it, or leave it blank.");
    }
    input.declaration = { statement: checked.statement, signatureId, ticketKey };
  }
  // GAP-312 (DF-P6): the equipment the request names — advisory, never a
  // refusal past its shape: an unusable entry is dropped with a warning.
  if (raw.equipment !== undefined && raw.equipment !== null) {
    if (!Array.isArray(raw.equipment)) return refuse("equipment", "The equipment list is not valid.");
    const equipment: TicketCreateEquipment[] = [];
    const seenTags = new Set<string>();
    for (const e of raw.equipment) {
      if (!isObj(e)) continue;
      const tag = text(e.tag);
      if (!tag || tag.length > MAX_EQUIPMENT_TAG) continue;
      const key = tag.toUpperCase();
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      const assetId = text(e.assetId);
      equipment.push({ tag, assetId: assetId && UUID_RE.test(assetId) ? assetId : null });
    }
    if (equipment.length > MAX_EQUIPMENT) {
      warnings.push(`Only the first ${MAX_EQUIPMENT} equipment tags were kept.`);
      equipment.length = MAX_EQUIPMENT;
    }
    if (equipment.length > 0) input.equipment = equipment;
  }
  // The DEC-40 seam travels with the input and is not acted on here.
  if ("projectId" in raw) input.projectId = text(raw.projectId);
  return { ok: true, input, warnings };
}

function parseOrigin(raw: unknown): TicketCreateOrigin | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "portal") return { kind: "portal" };
  if (raw.kind === "checkin") {
    const outcome = text(raw.outcome);
    if (!outcome) return null;
    const episodeId = text(raw.episodeId);
    if (episodeId && !UUID_RE.test(episodeId)) return null;
    let moc: CheckinMoc | null = null;
    if (raw.moc != null) {
      if (!isObj(raw.moc)) return null;
      const st = raw.moc.status;
      if (st !== "completed" && st !== "in_progress" && st !== "none" && st !== null) return null;
      moc = { status: st, number: st === "none" ? null : text(raw.moc.number) };
    }
    const n = raw.checkoutNumber == null ? null : Number(raw.checkoutNumber);
    return {
      kind: "checkin",
      episodeId,
      checkoutNumber: n != null && Number.isFinite(n) ? n : null,
      purpose: text(raw.purpose),
      outcome,
      moc,
      minorCorrection: raw.minorCorrection === true,
      undocumentedChange: raw.undocumentedChange === true,
    };
  }
  if (raw.kind === "intake_collision") {
    const projectId = text(raw.projectId);
    const sheetLabel = text(raw.sheetLabel);
    if (!projectId || !UUID_RE.test(projectId) || !sheetLabel) return null;
    // The ids the route checks against the project and the workspace.
    const intakeLinkId = text(raw.intakeLinkId);
    const numberCollisionDocId = text(raw.numberCollisionDocId);
    if ((intakeLinkId && !UUID_RE.test(intakeLinkId)) || (numberCollisionDocId && !UUID_RE.test(numberCollisionDocId))) return null;
    const overlaps: Array<{ id: string; label: string; sharedTags: string[] }> = [];
    let overlapsTotal = 0;
    let overlapsTruncated = false;
    if (raw.overlaps != null) {
      if (!Array.isArray(raw.overlaps)) return null;
      overlapsTotal = raw.overlaps.length;
      if (overlapsTotal > MAX_COLLISION_OVERLAPS) overlapsTruncated = true;
      for (const o of raw.overlaps.slice(0, MAX_COLLISION_OVERLAPS)) {
        if (!isObj(o)) return null;
        const tags = Array.isArray(o.sharedTags) ? o.sharedTags.map((t) => String(t)) : [];
        if (tags.length > MAX_OVERLAP_TAGS) overlapsTruncated = true;
        overlaps.push({
          id: String(o.id ?? ""),
          label: String(o.label ?? ""),
          sharedTags: tags.slice(0, MAX_OVERLAP_TAGS),
        });
      }
    }
    return {
      kind: "intake_collision",
      projectId,
      intakeLinkId,
      numberCollisionDocId,
      overlaps,
      overlapsTotal,
      overlapsTruncated,
      sheetLabel,
    };
  }
  return null;
}

// ── The workspace's own rules ───────────────────────────────────────────────

export interface UnitOption { value: string; label: string }

/** THE unit list — the one resolver the request form and the create route
 *  both call, so the form never offers a unit the route refuses: the
 *  workspace's saved request-form units (its `drafting` org_configurations
 *  row), else the Site Codebook's units, else none (free text). `cfg` is the
 *  SAVED row's data — null when the workspace never saved one; a caller
 *  never passes a built-in default list here. */
export function unitOptionsFor(
  cfg: Pick<OrgDraftingSettings, "units"> | null | undefined,
  codebookUnits: ReadonlyArray<{ code: string; label?: string | null }>,
): UnitOption[] {
  const configured = cfg?.units?.options ?? [];
  if (configured.length > 0) return configured.map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
  return codebookUnits.map((u) => ({ value: u.code, label: u.label ? `${u.code} — ${u.label}` : u.code }));
}

/** DCW-7: where a unit stands against the workspace's list.
 *   none       — no unit given (UNIT_UNKNOWN_LABEL)
 *   matched    — one of the list's values (case and spacing forgiven, a
 *                label accepted for its value)
 *   free       — the workspace has no list: the text as typed
 *   unmatched  — the workspace has a list and the text is not on it */
export function resolveUnit(
  raw: string | null,
  options: readonly UnitOption[],
): { kind: "none" | "matched" | "free" | "unmatched"; unit: string | null } {
  const u = raw?.trim() || null;
  if (!u) return { kind: "none", unit: null };
  if (options.length === 0) return { kind: "free", unit: u };
  const exact = options.find((o) => o.value === u);
  if (exact) return { kind: "matched", unit: exact.value };
  const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const loose = options.find((o) => fold(o.value) === fold(u) || fold(o.label) === fold(u));
  if (loose) return { kind: "matched", unit: loose.value };
  return { kind: "unmatched", unit: u };
}

/** A unit derived from a source document: several candidates (the
 *  document's metadata unit — what the check-in and the collision always
 *  wrote — then its codebook unit_code), the first that is ON the list wins;
 *  when none is, the first one given, as resolveUnit classes it (free with
 *  no list, else unmatched — kept and marked unit_unlisted). */
export function resolveDerivedUnit(
  candidates: ReadonlyArray<string | null | undefined>,
  options: readonly UnitOption[],
): { kind: "none" | "matched" | "free" | "unmatched"; unit: string | null } {
  const given = candidates.map((c) => (typeof c === "string" ? c.trim() : "")).filter((c) => c !== "");
  for (const c of given) {
    const r = resolveUnit(c, options);
    if (r.kind === "matched") return r;
  }
  return given.length > 0 ? resolveUnit(given[0], options) : { kind: "none", unit: null };
}

/** EDGE-13: what a failed tickets insert proves about the row.
 *   duplicate  — 23505: the number is already on a row (never given back;
 *                the route files under a fresh number once);
 *   definite   — Postgres refused the statement with its own SQLSTATE: the
 *                transaction did not commit, nothing was written;
 *   ambiguous  — no SQLSTATE (supabase-js reports a dropped connection or a
 *                lost reply with code ""), a PostgREST code, a connection
 *                exception (class 08) or a terminated backend (57P0x): the
 *                write may have committed, so the number is never given
 *                back on this evidence alone. */
export function insertFailureKind(err: { code?: unknown } | null | undefined): "duplicate" | "definite" | "ambiguous" {
  const code = typeof err?.code === "string" ? err.code : "";
  if (code === "23505") return "duplicate";
  if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08") && !code.startsWith("57P")) return "definite";
  return "ambiguous";
}

/** DCW-7 / FRIC-3: what a failed read of the Site Codebook's units
 *  (`codebook_entries`, kind "unit") means — the one classification the
 *  request form and the create route both apply, so they fail the same way:
 *   none        — the read answered;
 *   missing     — the codebook is not there yet (20260928 not pasted): no
 *                 list, the free-text box — a setup gap, not a fault;
 *   unreadable  — the codebook is there but could not be read: a list the
 *                 unit cannot be checked against. The route then files the
 *                 request as "Unit unknown" with the unit given kept on the
 *                 record (metadata.unit_unchecked) and says so; the form says
 *                 the list could not be loaded. Never a silent admission. */
export function unitListReadFailure(err: { code?: unknown; message?: unknown } | null | undefined): "none" | "missing" | "unreadable" {
  if (!err) return "none";
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message : "";
  if (code === "42P01" || code === "PGRST205" || /codebook_entries.*(does not exist|schema cache)/i.test(msg)) return "missing";
  return "unreadable";
}

/** 20261038 ticket_insert_integrity's request-type rule, verbatim: a
 *  workspace with a configured list accepts its values and the built-in
 *  check-in / transition-in vocabulary; one with no list accepts any type. */
export function requestTypeAllowed(type: string, cfg: Pick<OrgDraftingSettings, "requestTypes"> | null | undefined): boolean {
  const opts = (cfg?.requestTypes?.options ?? []).map((o) => String(o.value));
  if (opts.length === 0) return true;
  return opts.includes(type) || BUILTIN_REQUEST_TYPES.includes(type);
}

/** The first required custom field left empty in an enabled category — the
 *  same rule the request form applies before it submits. */
export function missingRequiredCustomField(
  cfg: Pick<OrgDraftingSettings, "customCategories"> | null | undefined,
  values: Record<string, Record<string, unknown>> | null,
): { field: string; error: string } | null {
  for (const cat of (cfg?.customCategories ?? []).filter((c) => c.enabled)) {
    const vals = values?.[cat.id] ?? {};
    for (const f of cat.fields) {
      if (!f.required) continue;
      const v = vals[f.key];
      const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) return { field: `custom:${cat.id}.${f.key}`, error: `"${f.label}" (${cat.label}) is required.` };
    }
  }
  return null;
}

// ── The requester, stamped from the membership (20261038, replicated) ───────

export interface CreatorMember {
  role: string | null;
  roles: string[] | null;
  email: string | null;
  display_name?: string | null;
}

/** 20261038 ticket_insert_integrity, line for line: the stamped role must be
 *  one the caller holds (`COALESCE(roles, ARRAY[role])`), otherwise their
 *  headline. A service-role insert skips the trigger, so the route applies
 *  this itself. */
export function stampedRequesterRole(requested: string | null, member: CreatorMember): string | null {
  const held = member.roles ?? (member.role != null ? [member.role] : []);
  if (requested != null && held.includes(requested)) return requested;
  return member.role;
}

/** AUTHZ-3 (hand-off to DF-P2): the requester's name from the membership —
 *  display name, else the local part of their email — never the client's. */
export function stampedRequesterName(member: CreatorMember, accountEmail: string | null): string {
  const display = typeof member.display_name === "string" ? member.display_name.trim() : "";
  if (display) return display;
  const email = (member.email || accountEmail || "").trim();
  return email ? email.split("@")[0] : "Unknown";
}

// ── What the row says ───────────────────────────────────────────────────────

/** The check-in MOC line — the description and the history entry share it. */
export function checkinMocLine(moc: CheckinMoc | null): string | null {
  if (!moc) return null;
  if (moc.status === "none") return "MOC: NONE ON RECORD — flagged as an undocumented field change.";
  return `MOC ${moc.status === "completed" ? "completed" : "in progress"}: ${(moc.number ?? "").trim()}`;
}

/** The reporter's own words in a check-in's description: the note, without
 *  the MOC line the panel appends (CheckInPanel joins them with a blank
 *  line). */
export function checkinNoteOf(description: string, moc: CheckinMoc | null): string {
  const line = checkinMocLine(moc);
  const d = description ?? "";
  if (line && d.endsWith(line)) return d.slice(0, d.length - line.length).replace(/\s+$/, "");
  return d.trim();
}

/** LIFE-7: the PSM escalation for an undocumented field change — the words
 *  the check-in panel sent, now sent by the create route (DF-P2 review fix). */
export function psmAlertNotice(p: { reporter: string; docLabel: string; note: string }): { title: string; body: string } {
  return {
    title: `PSM alert: undocumented field change — ${p.docLabel}`,
    body: `${p.reporter} reported the field differs from ${p.docLabel} with no MOC on record: "${p.note.trim()}"`,
  };
}

/** The ticket's opening history, per door — the lines each door wrote before. */
export function openingHistory(p: {
  origin: TicketCreateOrigin;
  email: string | null;
  role: string | null;
  now: string;
  primary: SourceDocumentRefRow | null;
}): Array<Record<string, unknown>> {
  const { origin, email, role, now, primary } = p;
  if (origin.kind === "checkin") {
    const docLabel = primary?.document_number || primary?.title || "Document";
    const mocLine = checkinMocLine(origin.moc);
    return [{
      action: "Created via Check-in", user: email, role, date: now,
      details: `Source Document: ${docLabel} Rev ${primary?.rev || "?"}${mocLine ? ` · ${mocLine}` : ""}`,
    }];
  }
  if (origin.kind === "intake_collision") {
    return [{
      action: "Created from transition-in impact scan",
      user: email, date: now,
      details: `Project intake sheet: ${origin.sheetLabel}`,
    }];
  }
  const out: Array<Record<string, unknown>> = [
    { action: "Created", user: email, role, date: now, details: "Ticket created via portal" },
  ];
  if (primary) {
    out.push({
      action: "Source Linked", user: email, role, date: now,
      details: `Sent from document viewer · ${primary.document_number || primary.title || primary.id} Rev ${primary.rev || "?"}`,
    });
  }
  return out;
}

/** The new-request notice each door sends to the assignment queue. */
export function creationNotice(origin: TicketCreateOrigin, ticketTitle: string): { title: string; body: string } {
  if (origin.kind === "checkin") {
    return {
      title: `New drafting request: ${ticketTitle}`,
      body: "Created from a document check-in. Ready for a drafter to be assigned.",
    };
  }
  if (origin.kind === "intake_collision") {
    return {
      title: `Intake collision flagged: ${origin.sheetLabel}`,
      body: origin.numberCollisionDocId
        ? "A submitted sheet collides with an existing document number — needs a drafter and a source-of-truth decision."
        : "A submitted sheet overlaps existing drawings — tie-in revision work to assign.",
    };
  }
  return { title: `New drafting request: ${ticketTitle}`, body: "Ready for a drafter to be assigned." };
}

// ── Staged attachments (EDGE-13) ────────────────────────────────────────────
// A file the requester attaches is uploaded only after the form is valid,
// and then under a PENDING prefix of their own — no request number exists
// yet, and none is spent on a submit that fails. The route re-keys each one
// under the ticket's own prefix once the row exists.

/** The prefix every attachment a requester stages lives under. */
export function ticketStagingPrefix(orgId: string, uid: string): string {
  return `orgs/${orgId}/tickets/pending/${uid}/`;
}

/** The `ticketId` argument uploadTicketAttachment takes for one submission's
 *  staging folder: orgs/<org>/tickets/pending/<uid>/<batch>/<ts>_<name>. */
export function ticketStagingFolder(uid: string, batch: string): string {
  return `pending/${uid}/${batch}`;
}

const STAGED_KEY_RE =
  /^orgs\/([0-9a-f-]{36})\/tickets\/pending\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(\d+_[A-Za-z0-9_.\-() ]*)$/i;

/** True when `key` is one file staged by `uid` for `orgId` — exactly
 *  <prefix><batch uuid>/<ts>_<sanitized name>, the shape the form mints. */
export function isStagedKeyOf(key: string, orgId: string, uid: string): boolean {
  const m = STAGED_KEY_RE.exec(key);
  return !!m && m[1].toLowerCase() === orgId.toLowerCase() && m[2].toLowerCase() === uid.toLowerCase();
}

/** Where a staged file lives once its ticket exists: the ticket's own prefix
 *  (orgs/<org>/tickets/<request number>/, what every later attachment and
 *  the ticket shed use), same file name. */
export function finalAttachmentKey(orgId: string, ticketNumber: string, stagedKey: string): string {
  const name = stagedKey.slice(stagedKey.lastIndexOf("/") + 1);
  return `orgs/${orgId}/tickets/${ticketNumber}/${name}`;
}

/** The size a ticket attachment shows, from the stored object's length. */
export function attachmentSizeLabel(bytes: number | null | undefined): string {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
    ? (bytes / 1024 / 1024).toFixed(2) + " MB"
    : "—";
}
