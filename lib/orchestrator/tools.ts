// lib/orchestrator/tools.ts — SERVER-ONLY. The hands.
//
// The difference between a chatbot bolted onto a database and a document
// controller is this file. A chatbot tells you it drafted the transmittal. A
// controller calls a function that actually does it, under the same
// permissions as the person who asked.
//
// Two rules run through everything here:
//
//   1. NOTHING WIDENS ACCESS. Every handler is org-scoped and re-checks the
//      caller. An orchestrator that can read more than the person driving it
//      is a data leak with a friendly interface.
//
//   2. WRITES ARE PROPOSED, NEVER PERFORMED. Reading is free; checking out a
//      document locks it for a colleague and notifying personnel puts a
//      message in someone's inbox. Those come back as pending actions for a
//      human to confirm. A model that misread a tag must not be able to lock
//      the wrong drawing, and "the AI did it" is not an audit trail anybody
//      should accept.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readableControlledDocIds, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import { orIlikeContains, type ParamSpec } from "@/lib/orchestrator/protocol";
import { tracePath, traceNeighbourhood, normalizeTag, type LineEdge } from "@/lib/pidTrace";
import { isControllerPrincipal } from "@/lib/permissions";
import { holdsReadOnlyRole } from "@/lib/roleHeld";
import { RANK, replaceDecision, storedProvisional, type AuditStatus } from "@/lib/drawingAuditLog";

export interface ToolContext {
  orgId: string;
  userId: string;
  role: string;
  /** SURF-7 / EGRESS-3: the caller's ACL principal (role collection, teams,
   *  controller tier). Every tool that touches a controlled document filters
   *  through it — the service-role key never widens what the caller may see. */
  principal: KnowledgePrincipal;
  /** The caller's display name, for anything sent in their name. */
  actorName: string;
  /** Actions the human has already approved this turn, by fingerprint. */
  approved: ReadonlySet<string>;
}

/** What a write tool wants to do, waiting on a person. */
export interface PendingAction {
  fingerprint: string;
  tool: string;
  summary: string;
  parameters: Record<string, unknown>;
  /**
   * Set when confirming does NOT execute server-side.
   *
   * Checking out a document runs through DB guards, episode bookkeeping and
   * capability checks that exist precisely so no single code path can shortcut
   * them. The orchestrator holds a service-role key, so "just insert the row"
   * would sail straight past all of it. Instead the confirm button carries the
   * user into the real flow, already filled in, and the write happens under
   * their own session like every other checkout in the product.
   */
  href?: string;
}

export interface ToolResult {
  /** JSON-ish payload handed back to the model. */
  data: unknown;
  /** Set when the tool needs a human before it will act. */
  pending?: PendingAction;
}

export interface ToolDef {
  name: string;
  description: string;
  params: readonly ParamSpec[];
  /** True for anything that changes state or leaves the building. */
  writes?: boolean;
  run: (args: Record<string, string | number | boolean>, ctx: ToolContext) => Promise<ToolResult>;
}

/** The controller tier — Admin or DocCtrl, held anywhere in the role
 *  COLLECTION (DEC-2) — through the app's one definition
 *  (lib/permissions isControllerPrincipal, the same set is_org_controller
 *  uses). No local role list (ORCH-8): Manager and Supervisor are not the
 *  controller tier anywhere else, so they are not here either. */
function holdsControllerTier(ctx: ToolContext): boolean {
  return isControllerPrincipal(ctx.principal);
}

/**
 * ORCH-8: may the caller EDIT this document (check it out, revise it)? The
 * answer the real door gives, not a role list:
 *   - the controller tier always may;
 *   - a read-only role (Viewer / Auditor, held anywhere — lib/roleHeld,
 *     deny-if-any) never does;
 *   - anyone else may unless the document's ACL index (the merged library →
 *     folder → document chain) denies them `write` or `editMetadata` — the
 *     predicate documents_deny_write_guard (20260901) applies, evaluated by
 *     the database's own acl_index_denies, so the two cannot drift.
 * Fails closed: an index that cannot be evaluated is a "no".
 */
async function mayEdit(ctx: ToolContext, aclIndex: unknown): Promise<boolean> {
  if (holdsControllerTier(ctx)) return true;
  if (holdsReadOnlyRole(ctx.principal.roles)) return false;
  if (!aclIndex) return true;
  for (const action of ["write", "editMetadata"]) {
    const { data, error } = await supabaseAdmin.rpc("acl_index_denies", {
      p_idx: aclIndex, p_org: ctx.orgId, p_uid: ctx.userId, p_action: action,
    });
    if (error || data !== false) return false;
  }
  return true;
}

/** SURF-7: which of these controlled documents may the CALLER read? Fails
 *  CLOSED — if the readable set cannot be computed, nothing is readable. */
async function readableIds(ctx: ToolContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try { return await readableControlledDocIds(ctx.principal, ids); }
  catch { return new Set(); }
}

/** SURF-7 / IEDGE-2: which of these KNOWLEDGE documents are mirrors of a
 *  controlled document the caller may NOT read? The same hop the knowledge
 *  ask route makes. Upload-origin knowledge documents (no source) stay
 *  org-readable and are never excluded here. Fails CLOSED: if the hop cannot
 *  be evaluated, every id given is treated as unreadable. */
async function unreadableMirrors(ctx: ToolContext, knowledgeDocIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(knowledgeDocIds.filter((id) => id && id !== "null" && id !== "undefined"))];
  if (ids.length === 0) return new Set();
  try {
    const mirrored: Array<{ id: string; source_document_id: string }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from("knowledge_documents").select("id, source_document_id")
        .in("id", ids.slice(i, i + 200)).not("source_document_id", "is", null);
      if (error) throw error;
      mirrored.push(...((data ?? []) as Array<{ id: string; source_document_id: string }>));
    }
    if (mirrored.length === 0) return new Set();
    const readable = await readableControlledDocIds(ctx.principal, [...new Set(mirrored.map((m) => m.source_document_id))]);
    return new Set(mirrored.filter((m) => !readable.has(m.source_document_id)).map((m) => m.id));
  } catch { return new Set(ids); }
}

/** Stable id for "this exact action", so approving one thing approves that
 *  thing and not the next thing the model thought of. */
export function fingerprint(tool: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  const canonical = keys.map((k) => `${k}=${String(params[k])}`).join("&");
  return `${tool}(${canonical})`;
}

const LIMIT = 25;

// ─── READ TOOLS ────────────────────────────────────────────────────────────

const findDocuments: ToolDef = {
  name: "find_documents",
  description:
    "Find controlled documents by number or title. Use for 'where did I store X' "
    + "and whenever the user names a drawing or document.",
  params: [
    { name: "query", type: "string", required: true, description: "Number or words from the title." },
  ],
  async run(args, ctx) {
    const q = String(args.query);
    const { data, error } = await supabaseAdmin
      .from("documents")
      .select("id, document_number, title, rev, status, library_id, updated_at")
      .eq("org_id", ctx.orgId)
      // PILLAR A. `ai_excluded` is the per-document carve-out a controller sets
      // when a document must stay invisible to anything automated. It is
      // honoured here explicitly because this code runs on the service-role
      // key, where RLS would not stop us.
      .eq("ai_excluded", false)
      // ORCH-6: the model's text is a quoted, escaped literal — a comma or a
      // parenthesis in a title no longer re-splits the filter list.
      .or(orIlikeContains(["document_number", "title"], q))
      .neq("status", "Archived")
      .order("updated_at", { ascending: false })
      .limit(LIMIT * 4);
    // ORCH-6: a failed lookup is reported as a failure — never as "no
    // documents", which the model would pass on as a true absence.
    if (error) {
      return { data: { error: "The document lookup failed — this is NOT the same as finding nothing. Say it could not be checked.", matches: null } };
    }
    // SURF-7: only what the caller could open themselves.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const readable = await readableIds(ctx, rows.map((r) => String(r.id)));
    return {
      data: {
        matches: rows.filter((r) => readable.has(String(r.id))).slice(0, LIMIT).map((d) => {
          const r = d as Record<string, unknown>;
          return {
            document_id: r.id, number: r.document_number, title: r.title,
            rev: r.rev, status: r.status,
            open_url: `/documents/${r.library_id}?doc=${r.id}`,
          };
        }),
      },
    };
  },
};

const searchDocuments: ToolDef = {
  name: "search_documents",
  description:
    "Search the TEXT of indexed documents — standards, procedures, reports. Use for "
    + "questions about content ('any standards about pipe supports'), not for finding "
    + "a document by its number. Returns passages with page citations.",
  params: [
    { name: "query", type: "string", required: true, description: "What to look for." },
    { name: "limit", type: "number", description: "Max passages (default 12)." },
  ],
  async run(args, ctx) {
    const limit = Math.min(Number(args.limit ?? 12) || 12, 30);
    const { data, error } = await supabaseAdmin.rpc("graph_ask", {
      p_org_id: ctx.orgId, p_query: String(args.query), p_limit: limit,
    });
    if (error) return { data: { error: "Text search isn't installed yet.", passages: [] } };
    // graph_ask runs on the service role here, so the ai_excluded boundary
    // (documents.ai_excluded, the per-document "keep AI out" carve-out that
    // every other AI surface honors) must be applied at this layer — the
    // RPC itself doesn't know about it. Map excluded doc-control documents
    // to their knowledge mirrors via source_document_id.
    const excluded = new Set<string>();
    try {
      const { data: exDocs } = await supabaseAdmin
        .from("documents").select("id")
        .eq("org_id", ctx.orgId).eq("ai_excluded", true).limit(2000);
      const exIds = new Set(((exDocs ?? []) as Array<{ id: string }>).map((r) => r.id));
      if (exIds.size > 0) {
        const { data: mirrors } = await supabaseAdmin
          .from("knowledge_documents").select("id, source_document_id")
          .eq("org_id", ctx.orgId).not("source_document_id", "is", null).limit(4000);
        for (const m of (mirrors ?? []) as Array<{ id: string; source_document_id: string }>) {
          if (exIds.has(m.source_document_id)) excluded.add(m.id);
        }
      }
    } catch { /* columns absent on old schemas — nothing to exclude */ }
    // SURF-7: a passage from a knowledge MIRROR of a controlled document is
    // only returned when the caller may read that document (the same hop the
    // knowledge ask route makes). Fails closed for mirrors; upload-origin
    // knowledge documents stay org-readable, unchanged.
    const kIds = ((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.knowledge_document_id));
    for (const id of await unreadableMirrors(ctx, kIds)) excluded.add(id);
    return {
      data: {
        passages: (data ?? [])
          .filter((r: Record<string, unknown>) => !excluded.has(String(r.knowledge_document_id)))
          .map((r: Record<string, unknown>) => ({
            document: r.document_name, page: r.page,
            text: String(r.snippet ?? "").replace(/<\/?b>/g, ""),
          })),
      },
    };
  },
};

const queryEquipmentByUnit: ToolDef = {
  name: "query_equipment_by_unit",
  description: "List the equipment registered in a unit, by unit name or code.",
  params: [{ name: "unit_name", type: "string", required: true, description: "Unit name or code." }],
  async run(args, ctx) {
    const u = String(args.unit_name);
    const { data, error } = await supabaseAdmin
      .from("assets")
      .select("id, tag, description, unit_code")
      .eq("org_id", ctx.orgId).eq("archived", false)
      .or(orIlikeContains(["unit_code", "description"], u))
      .limit(100);
    if (error) {
      return { data: { unit: u, error: "The equipment lookup failed — this is NOT the same as an empty unit. Say it could not be checked.", equipment: null } };
    }
    return {
      data: {
        unit: u,
        equipment: (data ?? []).map((a) => {
          const r = a as Record<string, unknown>;
          return { tag: r.tag, description: r.description, unit: r.unit_code };
        }),
      },
    };
  },
};

const equipmentMentions: ToolDef = {
  name: "equipment_mentions",
  description:
    "Every document that mentions a piece of equipment, with the sentence proving it. "
    + "Use to answer 'what do we have on E-101'.",
  params: [{ name: "tag", type: "string", required: true, description: "Equipment tag, e.g. E-101." }],
  async run(args, ctx) {
    const norm = normalizeTag(String(args.tag));
    const { data: assets } = await supabaseAdmin
      .from("assets").select("id, tag").eq("org_id", ctx.orgId).eq("archived", false).limit(3000);
    const match = (assets ?? []).find((a) => normalizeTag((a as { tag: string }).tag) === norm);
    if (!match) return { data: { tag: args.tag, found: false, note: "No such equipment in the registry." } };

    const { data } = await supabaseAdmin
      .from("entity_mentions")
      .select("page, context_snippet, mention_count, knowledge_document_id, document_id, knowledge_documents(name)")
      .eq("org_id", ctx.orgId).eq("asset_id", (match as { id: string }).id)
      .order("mention_count", { ascending: false })
      .limit(LIMIT * 4);
    // SURF-7 / IEDGE-2: the proving sentence is document content — a mention
    // is returned only when the caller may read the document it came from
    // (the controlled document directly, or through its knowledge mirror).
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const [hiddenMirrors, readableDocs] = await Promise.all([
      unreadableMirrors(ctx, rows.map((r) => String(r.knowledge_document_id ?? ""))),
      readableIds(ctx, [...new Set(rows.map((r) => r.document_id).filter((d): d is string => typeof d === "string" && d.length > 0))]),
    ]);
    const visible = rows.filter((r) => {
      if (typeof r.knowledge_document_id === "string" && hiddenMirrors.has(r.knowledge_document_id)) return false;
      if (typeof r.document_id === "string" && r.document_id.length > 0 && !readableDocs.has(r.document_id)) return false;
      return true;
    }).slice(0, LIMIT);
    return {
      data: {
        tag: (match as { tag: string }).tag,
        found: true,
        mentions: visible.map((m) => {
          const r = m as Record<string, unknown>;
          const kd = r.knowledge_documents as { name?: string } | { name?: string }[] | null;
          const name = Array.isArray(kd) ? kd[0]?.name : kd?.name;
          return { document: name ?? "document", page: r.page, times: r.mention_count, evidence: r.context_snippet };
        }),
      },
    };
  },
};

const checkPermissions: ToolDef = {
  name: "check_permissions",
  description: "Whether the current user may read or edit a document. Check before proposing any action on it.",
  params: [{ name: "document_id", type: "string", required: true, description: "Document UUID." }],
  async run(args, ctx) {
    // SURF-7: this code runs on the service-role key, so RLS is NOT the gate
    // here — the caller's ACL principal is evaluated explicitly, and a "no"
    // is the same "no" the database would give the caller directly.
    const { data } = await supabaseAdmin
      .from("documents").select("id, document_number, status, org_id, acl_index")
      .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
    if (!data) return { data: { readable: false, editable: false, note: "Not visible to this user." } };
    const readable = await readableIds(ctx, [String(args.document_id)]);
    if (!readable.has(String(args.document_id))) {
      return { data: { readable: false, editable: false, note: "Not visible to this user." } };
    }
    // A document can carry several open holds at once (one per reason), so
    // this asks "any" rather than "the" — maybeSingle() would throw on the
    // second one and report a permission answer as an error.
    const { data: holds } = await supabaseAdmin
      .from("document_holds").select("id, reason")
      .eq("document_id", String(args.document_id)).is("released_at", null).limit(5);
    const hold = (holds ?? []).length > 0;
    // ORCH-8: editable is the real door's answer for THIS caller on THIS
    // document (mayEdit), not a role list — a Drafter the ACL grants is
    // told yes, anyone the ACL denies write is told no.
    const canEdit = await mayEdit(ctx, (data as { acl_index?: unknown }).acl_index);
    return {
      data: {
        readable: true,
        editable: canEdit && !hold,
        on_hold: hold,
        holds: (holds ?? []).map((h) => (h as { reason: string }).reason),
        status: (data as { status: string }).status,
      },
    };
  },
};

const checkAuditHistory: ToolDef = {
  name: "check_audit_history",
  description:
    "Whether a drawing sheet was already audited at a given revision. Call this BEFORE "
    + "auditing anything — re-auditing an unrevised sheet is wasted work.",
  params: [
    { name: "sheet_number", type: "string", required: true, description: "Sheet or drawing number." },
    { name: "revision", type: "string", description: "Revision code, if known." },
  ],
  async run(args, ctx) {
    let q = supabaseAdmin.from("drawing_audit_logs")
      .select("sheet_number, revision_code, status, audited_at, audit_details")
      .eq("org_id", ctx.orgId).eq("sheet_number", String(args.sheet_number));
    if (args.revision) q = q.eq("revision_code", String(args.revision));
    const { data, error } = await q.order("audited_at", { ascending: false }).limit(10);
    if (error) {
      return isMissingTable(error)
        ? { data: { audited: false, note: "Audit memory isn't installed yet." } }
        : { data: { audited: false, error: "The audit record could not be read — this is not the same as 'never audited'." } };
    }
    // One row per library that audited the sheet, plus the org-wide row
    // (DEC-68). Summarised — never the whole stored set — and each row says
    // whether it is SETTLED. A provisional row (audit_details.provisional)
    // is still waiting on a document that is not read whole; a `skipped` row
    // says only that the sheet could not be read; a verdict under an unknown
    // revision ("") is never "already recorded" (DWG-13).
    const history = ((data ?? []) as Array<{ revision_code: string; status: string; audited_at: string; audit_details: unknown }>).map((r) => {
      const d = (r.audit_details ?? {}) as { note?: unknown; provisional?: { waitingOn?: unknown } };
      const provisional = storedProvisional(r.audit_details);
      return {
        revision: r.revision_code, status: r.status, audited_at: r.audited_at,
        scope: libraryOf(r.audit_details) ? "library" : "org-wide",
        ...(typeof d.note === "string" && d.note ? { note: d.note.slice(0, 300) } : {}),
        ...(provisional ? {
          provisional: true,
          settled_status: provisional.settledStatus,
          waiting_on: Array.isArray(d.provisional?.waitingOn) ? (d.provisional?.waitingOn as unknown[]).map(String).slice(0, 6) : [],
        } : {}),
      };
    });
    const settled = history.filter((h) => h.status !== "skipped" && !h.provisional && h.revision !== "");
    const waiting = history.filter((h) => h.provisional);
    const severest = (rows: typeof history) =>
      rows.map((h) => h.status).sort((a, b) => (RANK[b as AuditStatus] ?? 9) - (RANK[a as AuditStatus] ?? 9))[0];
    let recommendation: string;
    if (history.length === 0) {
      recommendation = args.revision ? "Not audited at this revision — go ahead." : "Never audited — go ahead.";
    } else if (!args.revision) {
      recommendation = `Audited before (latest: rev ${history[0].revision || "unknown"}). `
        + "Ask which revision is in front of you before deciding.";
    } else if (settled.length > 0) {
      recommendation = `Already audited at this revision (${severest(settled)}). Skip it unless the drawing has been revised since.`;
    } else if (waiting.length > 0) {
      const names = [...new Set(waiting.flatMap((h) => h.waiting_on ?? []))];
      recommendation = "The verdict at this revision is PROVISIONAL — not settled. It is waiting on "
        + (names.length > 0 ? names.join(", ") : "a document that is not read whole yet")
        + ` (settled so far as ${severest(waiting.map((h) => ({ ...h, status: h.settled_status ?? h.status })))}). `
        + "Do not skip it: audit it again once what it waits on is read.";
    } else {
      recommendation = "Recorded only as skipped (it could not be read) — audit it.";
    }
    return { data: { audited: settled.length > 0, history, recommendation } };
  },
};

const tracePidLines: ToolDef = {
  name: "trace_pid_lines",
  description:
    "SHEET-LEVEL connectivity: which drawings connect two pieces of equipment, following "
    + "off-page references across sheets. Use for multi-drawing routes and 'which sheets is "
    + "this line on'. This knows co-occurrence, not drawn geometry — when both tags share a "
    + "sheet, the result names it so a human can read the drawn connection in the viewer.",
  params: [
    { name: "start_tag", type: "string", required: true, description: "Equipment tag to start from." },
    { name: "end_tag", type: "string", description: "Equipment tag to reach. Omit to list neighbours." },
    { name: "hops", type: "number", description: "Neighbourhood radius when no end tag (default 2)." },
  ],
  async run(args, ctx) {
    const edges = await loadLineGraph(ctx);
    // Say what this is built from. Claiming valve-level tracing when the
    // source is page co-occurrence would be a lie an engineer acts on.
    const basis =
      "Derived from equipment appearing together on the same drawing page, plus off-page "
      + "continuation references. This is sheet-level connectivity, not valve-by-valve line "
      + "tracing — intermediate components are only listed once line geometry is captured.";

    if (!args.end_tag) {
      const near = traceNeighbourhood(edges, String(args.start_tag), Number(args.hops ?? 2) || 2);
      return { data: { start: args.start_tag, connected: near, basis } };
    }
    const r = tracePath(edges, String(args.start_tag), String(args.end_tag));
    // When both tags sit on ONE sheet, say so and point at the viewer —
    // that is where a human reads the drawn connection. (An automated
    // line-follower was tried, in several revisions, against real SHX
    // drawings; endpoint location plus dense line-work kept it below the
    // reliability an engineer can act on, and it was retired deliberately.)
    let sameSheet: Array<{ sheet: string; page: number }> = [];
    try {
      const a = normalizeTag(String(args.start_tag));
      const b = normalizeTag(String(args.end_tag));
      const { data: entRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, page, tag")
        .eq("org_id", ctx.orgId).in("tag", [a, b]).eq("kind", "equipment").limit(4000);
      const byPage = new Map<string, Set<string>>();
      for (const row of (entRows ?? []) as Array<{ document_id: string; page: number; tag: string }>) {
        const k = `${row.document_id}#${row.page}`;
        byPage.set(k, (byPage.get(k) ?? new Set()).add(row.tag));
      }
      // SURF-7 / IEDGE-2: a sheet the caller cannot read is not named to them.
      const hidden = await unreadableMirrors(ctx, [...new Set([...byPage.keys()].map((k) => k.split("#")[0]))]);
      const hits = [...byPage].filter(([k, tags]) => tags.size === 2 && !hidden.has(k.split("#")[0])).map(([k]) => k);
      if (hits.length > 0) {
        const ids = [...new Set(hits.map((k) => k.split("#")[0]))];
        const { data: docs } = await supabaseAdmin
          .from("knowledge_documents").select("id, name").in("id", ids);
        const names = new Map(((docs ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
        sameSheet = hits.map((k) => {
          const [documentId, page] = k.split("#");
          return { sheet: names.get(documentId) ?? "Sheet", page: Number(page) };
        });
      }
    } catch { /* advisory only */ }
    return {
      data: {
        found: r.found, path: r.path, drawings: r.drawings,
        crosses_sheets: r.steps.some((s) => s.offPage),
        components: r.components,
        reason: r.reason, basis,
        ...(sameSheet.length > 0 ? {
          same_sheet: sameSheet,
          note:
            "Both tags are drawn on the SAME sheet — tell the reader which sheet and page, and that "
            + "the drawn connection is read off the sheet itself (the viewer rings both tags). Do not "
            + "invent the routing between them.",
        } : {}),
      },
    };
  },
};

/**
 * Build the connectivity graph from what extraction actually captured.
 *
 * Equipment on the same drawing page is connected on that page; an off-page
 * reference is an edge to another sheet. It is not line geometry, and the
 * tool result says so — an approximation labelled honestly beats an exact
 * answer that doesn't exist.
 */
async function loadLineGraph(ctx: ToolContext): Promise<LineEdge[]> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("document_id, page, kind, tag")
    .eq("org_id", ctx.orgId)
    .in("kind", TAG_ENTITY_KINDS as unknown as string[])
    .order("document_id", { ascending: true })
    .limit(20000);
  if (error) return [];

  // SURF-7 / IEDGE-2: the graph is built only from sheets the caller may read
  // — a trace must not walk a drawing they cannot open.
  const rowsAll = (data ?? []) as Array<{ document_id: string; page: number; kind: string; tag: string }>;
  const hidden = await unreadableMirrors(ctx, [...new Set(rowsAll.map((r) => r.document_id))]);

  const byPage = new Map<string, { equipment: string[]; refs: string[] }>();
  for (const row of rowsAll) {
    if (hidden.has(row.document_id)) continue;
    const key = `${row.document_id}#${row.page}`;
    const slot = byPage.get(key) ?? { equipment: [], refs: [] };
    (row.kind === "equipment" ? slot.equipment : slot.refs).push(row.tag);
    byPage.set(key, slot);
  }

  const edges: LineEdge[] = [];
  for (const [key, slot] of byPage) {
    const [documentId, page] = key.split("#");
    const eq = [...new Set(slot.equipment)];
    // A page with fifty tags would produce 1,225 edges and a hairball. Above
    // a sane width the page is an index or a list, not a flow diagram.
    if (eq.length > 12) continue;
    for (let i = 0; i < eq.length; i++) {
      for (let j = i + 1; j < eq.length; j++) {
        edges.push({ lineId: `p${page}`, from: eq[i], to: eq[j], drawingId: documentId });
      }
      for (const ref of new Set(slot.refs)) {
        edges.push({ lineId: ref, from: eq[i], to: ref, drawingId: documentId, offPage: true });
      }
    }
  }
  return edges;
}

// ─── WRITE TOOLS — proposed, never performed ───────────────────────────────

function proposal(
  tool: string,
  summary: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  href?: string,
): ToolResult | null {
  const fp = fingerprint(tool, params);
  // A handoff action never executes here no matter how many times it's
  // approved — the whole point is that the real flow does the write.
  if (!href && ctx.approved.has(fp)) return null;
  return {
    data: {
      status: "awaiting_confirmation",
      action: summary,
      note: "Reported to the user for approval. Do not call this again; continue with what you can answer.",
    },
    pending: { fingerprint: fp, tool, summary, parameters: params, href },
  };
}

const checkoutDocument: ToolDef = {
  name: "checkout_document",
  description:
    "Start a checkout of a document for the current user. Requires the user's confirmation, "
    + "which opens the document so they complete the checkout themselves.",
  writes: true,
  params: [
    { name: "document_id", type: "string", required: true, description: "Document UUID." },
    { name: "reason", type: "string", required: true, description: "Why it's being checked out." },
  ],
  async run(args, ctx) {
    const { data: doc } = await supabaseAdmin
      .from("documents").select("id, document_number, title, library_id, checked_out_by, checked_out_by_name, acl_index")
      .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
    if (!doc) return { data: { error: "No such document in this org." } };
    // SURF-7: a document the caller cannot read does not exist for them.
    if (!(await readableIds(ctx, [String(args.document_id)])).has(String(args.document_id))) {
      return { data: { error: "No such document in this org." } };
    }
    const d = doc as {
      document_number: string; library_id: string;
      checked_out_by: string | null; checked_out_by_name: string | null;
      acl_index?: unknown;
    };

    // Say the conflict out loud before proposing anything. Offering to check
    // out a document somebody else is already holding is how you get two
    // people editing the same drawing.
    if (d.checked_out_by && d.checked_out_by !== ctx.userId) {
      return {
        data: {
          error: `${d.document_number} is already checked out by ${d.checked_out_by_name ?? "another user"}.`,
          suggestion: "Tell the user who holds it rather than proposing a second checkout.",
        },
      };
    }
    // ORCH-8: the same door check_permissions reports. Proposing never
    // writes — the confirmation opens the real checkout flow, which enforces
    // its own guards under the user's session.
    if (!(await mayEdit(ctx, d.acl_index))) {
      return { data: { error: "This user can't edit this document, so it can't be checked out by them.", forbidden: true } };
    }

    const params = { document_id: args.document_id, reason: args.reason };
    return proposal(
      "checkout_document",
      `Open ${d.document_number} to check it out — ${args.reason}`,
      params, ctx,
      `/documents/${d.library_id}?doc=${args.document_id}`,
    ) as ToolResult;                       // href set ⇒ never null
  },
};

const notifyPersonnel: ToolDef = {
  name: "notify_personnel",
  description:
    "Send a colleague a notification about a specific document. Requires the user's confirmation.",
  writes: true,
  params: [
    { name: "user_id", type: "string", required: true, description: "Recipient's user id (UUID)." },
    { name: "document_id", type: "string", required: true, description: "The document it's about." },
    { name: "message", type: "string", required: true, description: "What to tell them." },
  ],
  async run(args, ctx) {
    const { data: doc } = await supabaseAdmin
      .from("documents").select("id, document_number, library_id")
      .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
    if (!doc) return { data: { error: "No such document in this org." } };
    // SURF-7: the caller must be able to read the document they are talking
    // about; otherwise it does not exist for them.
    if (!(await readableIds(ctx, [String(args.document_id)])).has(String(args.document_id))) {
      return { data: { error: "No such document in this org." } };
    }
    const d = doc as { document_number: string; library_id: string };

    // Membership check before the proposal, not after: an org id in a
    // parameter is not proof the recipient is in the org.
    const { data: member } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", ctx.orgId).eq("uid", String(args.user_id)).eq("status", "active").maybeSingle();
    if (!member) return { data: { error: "That user isn't an active member of this org." } };

    // Authority (DEC-44 (I-04), the plan default): any active member may
    // notify a colleague about a document they can read — a message is not
    // a record. It is sent in the caller's own name (actorName), proposed
    // like every write, and runs once, from the stored proposal.
    const params = { user_id: args.user_id, document_id: args.document_id, message: args.message };
    const gate = proposal(
      "notify_personnel",
      `Notify a colleague about ${d.document_number}: “${args.message}”`,
      params, ctx,
    );
    if (gate) return gate;

    const { emit } = await import("@/lib/notify/dispatch");
    await emit({
      orgId: ctx.orgId, category: "watched", kind: "orchestrator_message",
      title: `About ${d.document_number}`,
      body: String(args.message),
      link: `/documents/${d.library_id}?doc=${args.document_id}`,
      resource: { type: "document", id: String(args.document_id) },
      actorUserId: ctx.userId, actorName: ctx.actorName,
      audience: { involved: [String(args.user_id)] },
    }).catch(() => undefined);
    return { data: { status: "sent" } };
  },
};

type DbError = { code?: string; message?: string } | null | undefined;
const isMissingColumn = (e: DbError) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column .* does not exist/i.test(e.message ?? ""));
const isMissingTable = (e: DbError) =>
  !!e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? ""));

const AUDIT_STATUSES: readonly AuditStatus[] = ["passed", "broken_connectors", "flagged", "skipped"];

/** The library a drawing-route verdict names in its details, if any. */
function libraryOf(details: unknown): string | null {
  const l = (details as { libraryId?: unknown } | null)?.libraryId;
  return typeof l === "string" && l ? l : null;
}

/**
 * The ORG-WIDE verdict stored for (sheet, revision) — the row
 * log_audit_completion writes (DEC-68 item 2, 20261124: drawing_audit_logs
 * is unique on (org_id, library_id, sheet_number, revision_code) NULLS NOT
 * DISTINCT; an org-wide row has library_id NULL). Before 20261124 there is
 * no library_id column and the key is (org_id, sheet_number,
 * revision_code): `legacy` says so, and the row found there may be one a
 * library's audit filed.
 */
async function storedOrgWideVerdict(orgId: string, sheet: string, revision: string): Promise<
  { legacy: boolean; row: { status: string; revision_code: string; audit_details: unknown } | null } | { error: string }
> {
  const scoped = await supabaseAdmin
    .from("drawing_audit_logs").select("status, revision_code, audit_details, library_id")
    .eq("org_id", orgId).eq("sheet_number", sheet).eq("revision_code", revision)
    .is("library_id", null).maybeSingle();
  if (!scoped.error) return { legacy: false, row: scoped.data as { status: string; revision_code: string; audit_details: unknown } | null };
  if (isMissingTable(scoped.error)) return { error: "Audit memory isn't installed yet (migration 20260929)." };
  if (!isMissingColumn(scoped.error)) return { error: `The audit record could not be read: ${scoped.error.message}` };
  const legacy = await supabaseAdmin
    .from("drawing_audit_logs").select("status, revision_code, audit_details")
    .eq("org_id", orgId).eq("sheet_number", sheet).eq("revision_code", revision).maybeSingle();
  if (legacy.error) return { error: `The audit record could not be read: ${legacy.error.message}` };
  return { legacy: true, row: legacy.data as { status: string; revision_code: string; audit_details: unknown } | null };
}

/** Would writing `status` over the stored verdict lower what it settled?
 *  The drawing layer's own rule (lib/drawingAuditLog replaceDecision, RANK):
 *  a known revision's verdict is never lowered; a provisional row's floor is
 *  what it settled; on the pre-20261124 key a row a library filed is never
 *  lowered whatever its revision. Returns the refusal, or null to write. */
function lowersStored(
  stored: { status: string; revision_code: string; audit_details: unknown } | null,
  status: AuditStatus, legacy: boolean,
): string | null {
  if (!stored) return null;
  const provisional = storedProvisional(stored.audit_details);
  const decision = replaceDecision(
    { revision_code: stored.revision_code, status: stored.status, provisional },
    { status },
    { neverLower: legacy && !!libraryOf(stored.audit_details) },
  );
  if (decision === "write") return null;
  const floor = provisional ? provisional.settledStatus : stored.status;
  return `This sheet is already recorded as ${floor} at this revision; a less severe verdict (${status}) is not recorded over it.`;
}

const logAuditCompletion: ToolDef = {
  name: "log_audit_completion",
  description:
    "Record that a drawing sheet was audited at a revision, so it isn't audited again. The record is "
    + "org-wide and never lowers a more severe verdict already recorded for that sheet and revision. "
    + "Document controllers only. Requires the user's confirmation.",
  writes: true,
  params: [
    { name: "sheet_number", type: "string", required: true, description: "Sheet or drawing number." },
    { name: "revision", type: "string", required: true, description: "Revision code audited." },
    { name: "status", type: "string", required: true, description: "passed | broken_connectors | flagged | skipped" },
    { name: "details", type: "string", description: "What was found." },
  ],
  async run(args, ctx) {
    const status = String(args.status) as AuditStatus;
    if (!AUDIT_STATUSES.includes(status)) {
      return { data: { error: "status must be passed, broken_connectors, flagged, or skipped." } };
    }
    // ORCH-1 / PR-1 / SURF-7: recording an audit completion is a
    // controller-tier act (Admin / DocCtrl by the role collection — the same
    // gate /api/knowledge/drawing applies); the service-role write must not
    // let anyone else's confirmation mint one.
    if (!holdsControllerTier(ctx)) {
      return { data: { error: "Only Admin or Document Control can record an audit completion.", forbidden: true } };
    }
    const sheet = String(args.sheet_number);
    const revision = String(args.revision);
    // Never lower a verdict already settled for this key (DEC-68) — checked
    // before proposing, and again when the confirmation runs.
    const stored = await storedOrgWideVerdict(ctx.orgId, sheet, revision);
    if ("error" in stored) return { data: { error: stored.error } };
    const lowers = lowersStored(stored.row, status, stored.legacy);
    if (lowers) return { data: { error: lowers, kept: stored.row?.status ?? null } };

    const params = { sheet_number: args.sheet_number, revision: args.revision, status };
    const gate = proposal(
      "log_audit_completion",
      `Record ${args.sheet_number} rev ${args.revision} as ${status}`, params, ctx,
    );
    if (gate) return gate;

    // An ORG-WIDE row (library_id NULL) on 20261124's key; before 20261124,
    // the org-wide key that database has.
    const row = {
      org_id: ctx.orgId, sheet_number: sheet,
      revision_code: revision, status,
      audited_at: new Date().toISOString(),
      audit_details: { note: args.details ?? "", by: ctx.userId, byName: ctx.actorName, source: "orchestrator" },
    };
    const { error } = stored.legacy
      ? await supabaseAdmin.from("drawing_audit_logs").upsert(row, { onConflict: "org_id,sheet_number,revision_code" })
      : await supabaseAdmin.from("drawing_audit_logs").upsert({ ...row, library_id: null }, { onConflict: "org_id,library_id,sheet_number,revision_code" });
    if (error) return { data: { error: error.message } };
    return { data: { status: "logged" } };
  },
};

export const TOOLS: readonly ToolDef[] = [
  findDocuments, searchDocuments, queryEquipmentByUnit, equipmentMentions,
  checkPermissions, checkAuditHistory, tracePidLines,
  checkoutDocument, notifyPersonnel, logAuditCompletion,
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** The tool manual handed to the model. Generated, so it can never drift
 *  from what's actually callable. */
export function toolCatalogue(): string {
  return TOOLS.map((t) => {
    const params = t.params
      .map((p) => `${p.name}: ${p.type}${p.required ? "" : "?"} — ${p.description}`)
      .join("; ");
    return `- ${t.name}(${params || "no parameters"})${t.writes ? " [WRITE — needs confirmation]" : ""}\n  ${t.description}`;
  }).join("\n");
}
