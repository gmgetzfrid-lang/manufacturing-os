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
import { tracePath, traceNeighbourhood, normalizeTag, type LineEdge, type TraceStep } from "@/lib/pidTrace";
import { flowsToLineEdges, FLOW_EDGE_CEILING } from "@/lib/processFlows";
import { READ_PAGE, type PgErr } from "@/lib/knowledgeAskGuards";
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
 *   - a read-only role (Viewer / Auditor, held anywhere — lib/roleHeld,
 *     deny-if-any, with NO controller escape) never does: a member holding
 *     [DocCtrl, Viewer] is read-only on every app edit surface
 *     (holdsReadOnlyRole) until Viewer is removed, so they are told so here;
 *   - otherwise the controller tier always may;
 *   - anyone else may unless the document's ACL index (the merged library →
 *     folder → document chain) denies them `write` or `editMetadata` — the
 *     predicate documents_deny_write_guard (20260901) applies, evaluated by
 *     the database's own acl_index_denies, so the two cannot drift.
 * Fails closed: an index that cannot be evaluated is a "no".
 */
async function mayEdit(ctx: ToolContext, aclIndex: unknown): Promise<boolean> {
  if (holdsReadOnlyRole(ctx.principal.roles)) return false;
  if (holdsControllerTier(ctx)) return true;
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

/** I-21 fix pass 4: a deadline (a Date.now() instant) for a run of checks,
 *  and whether a check reached it. */
interface CheckBudget { deadline: number; outOfTime: boolean }

/** Is the budget spent? Marks it so when it is. No budget is never spent. */
function budgetSpent(budget: CheckBudget | undefined): boolean {
  if (!budget || Date.now() <= budget.deadline) return false;
  budget.outOfTime = true;
  return true;
}

/** SURF-7 / IEDGE-2: which of these KNOWLEDGE documents are mirrors of a
 *  controlled document the caller may NOT read? The same hop the knowledge
 *  ask route makes. Upload-origin knowledge documents (no source) stay
 *  org-readable and are never excluded here. Fails CLOSED: if the hop cannot
 *  be evaluated, every id given is treated as unreadable. With a budget (the
 *  line trace's, I-21 fix pass 4), no lookup starts past its deadline, and
 *  every id not cleared by then is treated as unreadable too. */
async function unreadableMirrors(ctx: ToolContext, knowledgeDocIds: string[], budget?: CheckBudget): Promise<Set<string>> {
  const ids = [...new Set(knowledgeDocIds.filter((id) => id && id !== "null" && id !== "undefined"))];
  if (ids.length === 0) return new Set();
  try {
    const mirrored: Array<{ id: string; source_document_id: string }> = [];
    const unchecked: string[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      if (budgetSpent(budget)) { unchecked.push(...ids.slice(i)); break; }
      const { data, error } = await supabaseAdmin
        .from("knowledge_documents").select("id, source_document_id")
        .in("id", ids.slice(i, i + 200)).not("source_document_id", "is", null);
      if (error) throw error;
      mirrored.push(...((data ?? []) as Array<{ id: string; source_document_id: string }>));
    }
    if (mirrored.length === 0) return new Set(unchecked);
    if (budgetSpent(budget)) return new Set([...unchecked, ...mirrored.map((m) => m.id)]);
    const readable = await readableControlledDocIds(ctx.principal, [...new Set(mirrored.map((m) => m.source_document_id))]);
    return new Set([...unchecked, ...mirrored.filter((m) => !readable.has(m.source_document_id)).map((m) => m.id)]);
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
    const { data: holds, error: holdsErr } = await supabaseAdmin
      .from("document_holds").select("id, reason")
      .eq("document_id", String(args.document_id)).is("released_at", null).limit(5);
    // A hold read that failed is not "no hold": editable is the real door's
    // answer, and the door refuses a held document — so it fails closed.
    if (holdsErr) {
      return { data: { readable: true, editable: false, on_hold: null, error: "Hold status could not be checked — this is not the same as no hold." } };
    }
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
    // The row's scope comes from its library_id column (20261124) — which
    // 20261124 also backfilled onto rows whose details never named a
    // library — and from audit_details.libraryId before that column exists.
    const read = (columns: string) => {
      let q = supabaseAdmin.from("drawing_audit_logs")
        .select(columns)
        .eq("org_id", ctx.orgId).eq("sheet_number", String(args.sheet_number));
      if (args.revision) q = q.eq("revision_code", String(args.revision));
      return q.order("audited_at", { ascending: false }).limit(10);
    };
    let { data, error } = await read("sheet_number, revision_code, status, audited_at, audit_details, library_id");
    if (isMissingColumn(error)) ({ data, error } = await read("sheet_number, revision_code, status, audited_at, audit_details"));
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
    const history = ((data ?? []) as unknown as Array<{ revision_code: string; status: string; audited_at: string; audit_details: unknown; library_id?: string | null }>).map((r) => {
      const d = (r.audit_details ?? {}) as { note?: unknown; provisional?: { waitingOn?: unknown } };
      const provisional = storedProvisional(r.audit_details);
      return {
        revision: r.revision_code, status: r.status, audited_at: r.audited_at,
        // The library_id column decides once it exists (20261124); only a read
        // without the column falls back to what the details name (integration fix).
        scope: ("library_id" in r ? !!r.library_id : !!libraryOf(r.audit_details)) ? "library" : "org-wide",
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
    } else if (waiting.length > 0) {
      // A provisional row ANYWHERE at this revision means the sheet is not
      // settled — also when another scope's row is (DWG-6: one sheet judged
      // in two libraries). Its severity counts what each provisional row
      // settled, so a verified finding still waiting on a neighbour is never
      // reported as the other library's `passed`, and it is never "skip it".
      const names = [...new Set(waiting.flatMap((h) => h.waiting_on ?? []))];
      const what = names.length > 0 ? names.join(", ") : "a document that is not read whole yet";
      const floor = severest([...settled, ...waiting.map((h) => ({ ...h, status: h.settled_status ?? h.status }))]);
      recommendation = "The verdict at this revision is PROVISIONAL — not settled"
        + (settled.length > 0
          ? ` (${settled.length} of the ${settled.length + waiting.length} records here ${settled.length === 1 ? "is" : "are"} settled; the rest are not)`
          : "")
        + `. It is waiting on ${what} (settled so far as ${floor}). `
        + `Do not skip it until ${names.length > 0 ? names.join(", ") : "what it waits on"} is read — then audit it again.`;
    } else if (settled.length > 0) {
      recommendation = `Already audited at this revision (${severest(settled)}). Skip it unless the drawing has been revised since.`;
    } else {
      recommendation = "Recorded only as skipped (it could not be read) — audit it.";
    }
    // `audited` means "settled — re-auditing is wasted work": never while a
    // provisional row waits (DEC-68 handoff), whatever else is settled.
    return {
      data: {
        audited: settled.length > 0 && waiting.length === 0,
        ...(waiting.length > 0 ? { provisional_pending: true } : {}),
        history, recommendation,
      },
    };
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
    const graph = await lineGraphFor(ctx);
    // GAP-315: the confirmed process flows the graph holds (after the
    // hidden-sheet filter). The answer names them (a flow basis, `route`,
    // `confirmed_flows`) only when it rests on one: a found route with a
    // confirmed-flow step; a no-route answer whose own start or end is on a
    // flow, or whose reason the flows change; a neighbourhood with a tag only
    // a flow brings that close, or a non-empty feeds / fed_by. Otherwise
    // every field below is as before flows were an input, whatever flows the
    // org holds elsewhere (I-21 fix pass 2).
    const flowEdges = graph.edges.filter((e) => e.basis === "confirmed_flow");
    const isFlow = (e: LineEdge) => e.basis === "confirmed_flow";
    // ING-10 residual / GAP-315: what the graph could not include, said — a
    // trace that read part of the index, or none of it, must not pass "no
    // route" off as proof. Each reason the graph is partial is named.
    const partialBecause = [
      graph.partial === "time"
        ? `reading the drawing tag index took longer than one trace may spend on it (${LINE_GRAPH_READ_BUDGET_MS / 1000} s)` : null,
      graph.partial === "ceiling"
        ? `the drawing tag index holds more rows than one trace reads (${LINE_GRAPH_ROW_CEILING.toLocaleString("en-US")})` : null,
      graph.partial === "failed"
        ? `a page of the drawing tag index could not be read (${graph.partialFailure})` : null,
      graph.checksOutOfTime
        ? `checking which of the drawings you may open took longer than one trace may spend on it (${LINE_GRAPH_CHECK_BUDGET_MS / 1000} s)`
        : null,
    ].filter((why): why is string => !!why);
    const notes = {
      ...(graph.indexUnavailable ? {
        graph_unavailable:
          `The drawing tag index could not be read (${graph.indexUnavailable}), so this trace has no sheet `
          + "co-occurrence. A route not found, or a tag that \"doesn't appear\", is NOT proof — say the trace "
          + "could not be checked.",
      } : {}),
      ...(partialBecause.length > 0 ? {
        graph_partial:
          `PARTIAL: ${partialBecause.join("; and ")}, `
          + "so some sheets were not walked. A route not found, or a tag that \"doesn't appear\", is NOT proof "
          + "the equipment is unconnected — say the trace is partial.",
      } : {}),
      ...(graph.flowsUnavailable ? {
        confirmed_flows_unavailable:
          `The plant's confirmed process flows could not be read (${graph.flowsUnavailable}), so this trace uses `
          + "sheet co-occurrence only. That is NOT the same as the plant having no confirmed flows — say so.",
      } : {}),
      ...(graph.flowsTruncated ? {
        confirmed_flows_partial:
          `More than ${FLOW_EDGE_CEILING.toLocaleString("en-US")} confirmed process flows exist; only that many were walked.`,
      } : {}),
    };

    if (!args.end_tag) {
      const start = String(args.start_tag);
      const hops = Number(args.hops ?? 2) || 2;
      const walk = equipmentWalk(graph, start);
      const near = traceNeighbourhood(walk, start, hops);
      // The tags in `connected` only a confirmed flow brings that close:
      // sheet co-occurrence alone does not reach them in as few runs. (Every
      // other tag is exactly where the sheets alone put it.)
      const bySheet = walk.some(isFlow)
        ? new Map(traceNeighbourhood(walk.filter((e) => !isFlow(e)), start, hops).map((n) => [n.tag, n.hops]))
        : null;
      const throughFlow = bySheet ? near.filter((n) => (bySheet.get(n.tag) ?? Infinity) > n.hops).map((n) => n.tag) : [];
      // GAP-315: scoped by traceNeighbourhood over the confirmed flows
      // alone, each followed only its stored way; a unit is reached, never
      // walked through (unless the walk starts there).
      const feeds = traceNeighbourhood(flowEdges, start, hops, "downstream", graph.units);
      const fedBy = traceNeighbourhood(flowEdges, start, hops, "upstream", graph.units);
      const withFlows = throughFlow.length > 0 || feeds.length > 0 || fedBy.length > 0;
      return {
        data: {
          start: args.start_tag, connected: near, basis: withFlows ? NEIGHBOURHOOD_BASIS_WITH_FLOWS : SHEET_BASIS,
          ...(withFlows ? {
            confirmed_flows: {
              feeds, fed_by: fedBy, connected_through_flow: throughFlow,
              note: "Directional, from CONFIRMED process flows only: `feeds` is what this equipment or unit "
                + "feeds (downstream), `fed_by` what feeds it (upstream). An empty list means no confirmed flow "
                + "is recorded that way — NOT that nothing feeds it, or that it feeds nothing. A UNIT<code> tag "
                + "is a whole operating unit (a Site Codebook unit), not a piece of equipment: these lists name "
                + "it and stop there. `connected` also counts sheet co-occurrence, which has no direction, and "
                + "never passes through a unit; `connected_through_flow` lists the tags in it that only a "
                + "confirmed flow brings that close.",
            },
          } : {}),
          ...notes,
        },
      };
    }
    const startTag = String(args.start_tag);
    const endTag = String(args.end_tag);
    const walk = equipmentWalk(graph, startTag, endTag);
    const r = tracePath(walk, startTag, endTag);
    // A found route rests on a flow when one of its steps is one. A no-route
    // answer does when its own start or end is on a flow the trace could
    // walk, or when the sheets alone would give a different reason (flows
    // elsewhere lengthening the search past its run limit). A flow anywhere
    // else in the org changes nothing here.
    const walkFlows = walk.filter(isFlow);
    // What the drawings alone give (with no flow in the walk, that is `r`).
    const bySheets = walkFlows.length > 0 ? tracePath(walk.filter((e) => !isFlow(e)), startTag, endTag) : r;
    const onFlow = (tag: string) => {
      const k = normalizeTag(tag);
      return walkFlows.some((e) => normalizeTag(e.from) === k || normalizeTag(e.to) === k);
    };
    const withFlows = r.found
      ? r.steps.some((s) => s.basis === "confirmed_flow")
      : walkFlows.length > 0 && (onFlow(startTag) || onFlow(endTag) || bySheets.reason !== r.reason);
    // I-21 fix pass 4: a route through a confirmed flow can skip a route the
    // drawings give (a flow read off the PFD joining the two ends directly,
    // past the tank the P&ID draws between them), and breadth-first search
    // takes the flow's. That route stays the answer (`path`), and the
    // drawings' own route is named beside it (`sheet_route`), with the
    // sheets it is on, so neither its equipment nor its sheets drop out
    // unsaid. A route through the same tags as the drawings' has none: its
    // flow steps name their sheets (`also_on_sheet`, below).
    const sheetRoute = withFlows && r.found && bySheets.found
      && (bySheets.path.length !== r.path.length || bySheets.path.some((t, i) => t !== r.path[i]))
      ? { path: bySheets.path, drawings: bySheets.drawings, crosses_sheets: bySheets.steps.some((s) => s.offPage) }
      : null;
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
    // I-21 fix pass 3: a step a confirmed flow takes keeps the sheet
    // evidence for its pair. Where a flow and sheet co-occurrence join the
    // same two tags, the flow comes first in that pair's adjacency and is the
    // step's edge, so tracePath cites only the flow's own source sheet (none
    // for a hand-drawn flow). The sheets that also carry the pair — in the
    // walk, so never a hidden one — are named on the step (`also_on_sheet`)
    // and kept in `drawings`, in route order; the first of them (the edge the
    // sheets alone would take for that step) keeps its off-page mark. A route
    // with no flow step is untouched.
    const pairKey = (a: string, b: string) => [normalizeTag(a), normalizeTag(b)].sort().join("|");
    const sheetsOfPair = new Map<string, LineEdge[]>();
    if (r.steps.some((s) => s.basis === "confirmed_flow")) {
      for (const e of walk) {
        if (e.basis !== "same_sheet") continue;
        const k = pairKey(e.from, e.to);
        const list = sheetsOfPair.get(k);
        if (list) list.push(e); else sheetsOfPair.set(k, [e]);
      }
    }
    const sheetTwins = (st: TraceStep): LineEdge[] =>
      (st.basis === "confirmed_flow" ? sheetsOfPair.get(pairKey(st.from, st.to)) ?? [] : []);
    const docsOf = (list: Array<string | undefined>) => [...new Set(list.filter((d): d is string => !!d))];
    const drawings = sheetsOfPair.size > 0
      ? docsOf(r.steps.flatMap((st) => [st.drawingId, ...sheetTwins(st).map((e) => e.drawingId)]))
      : r.drawings;
    // GAP-315 acceptance 1: each step of the route names its basis — the
    // confirmed flows on the path, which way the product moves along each,
    // and every co-occurrence step labelled as only that.
    const flowById = new Map(flowEdges.map((e) => [e.lineId, e]));
    const route = withFlows && r.found ? r.steps.map((st) => {
      const flow = st.basis === "confirmed_flow" ? flowById.get(st.lineId) : undefined;
      if (!flow) return { from: st.from, to: st.to, basis: "same sheet", ...(st.offPage ? { off_page: true } : {}) };
      const withTheFlow = normalizeTag(flow.from) === normalizeTag(st.from);
      const twins = sheetTwins(st);
      const alsoOn = docsOf(twins.map((e) => e.drawingId));
      return {
        from: st.from, to: st.to, basis: "confirmed flow",
        flow: withTheFlow ? `${st.from} feeds ${st.to}` : `${st.to} feeds ${st.from} (this step runs against the flow)`,
        ...(flow.label ? { stream: flow.label } : {}),
        ...(alsoOn.length > 0 ? { also_on_sheet: alsoOn } : {}),
        ...(twins[0]?.offPage ? { off_page: true } : {}),
      };
    }) : null;
    return {
      data: {
        found: r.found, path: r.path, drawings,
        crosses_sheets: r.steps.some((s) => s.offPage || !!sheetTwins(s)[0]?.offPage),
        components: r.components,
        reason: r.reason,
        basis: withFlows ? (r.found ? TRACE_BASIS_WITH_FLOWS : NO_ROUTE_BASIS_WITH_FLOWS) : SHEET_BASIS,
        ...(sameSheet.length > 0 ? {
          same_sheet: sameSheet,
          note:
            "Both tags are drawn on the SAME sheet — tell the reader which sheet and page, and that "
            + "the drawn connection is read off the sheet itself (the viewer rings both tags). Do not "
            + "invent the routing between them.",
        } : {}),
        ...(route ? { route } : {}),
        ...(sheetRoute ? { sheet_route: sheetRoute } : {}),
        ...notes,
      },
    };
  },
};

/** The trace's basis when its answer rests on sheet co-occurrence alone —
 *  the base commit's sentence, word for word. Say what this is built from:
 *  claiming valve-level tracing when the source is page co-occurrence would
 *  be a lie an engineer acts on. */
const SHEET_BASIS =
  "Derived from equipment appearing together on the same drawing page, plus off-page "
  + "continuation references. This is sheet-level connectivity, not valve-by-valve line "
  + "tracing — intermediate components are only listed once line geometry is captured.";

/** GAP-315: a found route's basis when a step of it is a confirmed flow. */
const TRACE_BASIS_WITH_FLOWS =
  "Two sources, named per step in `route`. A \"confirmed flow\" step is a CONFIRMED flow on the plant's "
  + "process map — a person drew it or confirmed it; it has a direction (one thing feeds the next). A "
  + "\"same sheet\" step is equipment appearing together on the same drawing page, or an off-page "
  + "continuation reference — sheet-level connectivity, not valve-by-valve line tracing. Proposed or "
  + "dismissed flows are never used. A \"confirmed flow\" step that lists `also_on_sheet` ALSO has its two "
  + "tags on the same drawing page of those sheets (they are in `drawings` too): name both sources for it. "
  + "When `sheet_route` is present, the drawings alone give a DIFFERENT route between the two "
  + "(`sheet_route.path`, on the sheets in `sheet_route.drawings`): name both routes, and do not drop the "
  + "equipment the drawn route passes through. "
  + "A UNIT<code> tag is a whole operating unit (a Site Codebook unit), not a piece of equipment: a route "
  + "may start or end at one but never passes through one. Say which steps are confirmed flows and which "
  + "are only on the same sheet; intermediate components are only listed once line geometry is captured.";

/** GAP-315 (I-21 fix pass 2): a no-route answer's basis when its start or
 *  end is on a confirmed flow, or the flows change its reason. No `route`. */
const NO_ROUTE_BASIS_WITH_FLOWS =
  "Searched two sources: CONFIRMED flows on the plant's process map (a person drew it or confirmed it; "
  + "proposed or dismissed flows are never used), and equipment appearing together on the same drawing "
  + "page, plus off-page continuation references (sheet-level connectivity, not valve-by-valve line "
  + "tracing). A UNIT<code> tag is a whole operating unit (a Site Codebook unit), not a piece of "
  + "equipment: a route may start or end at one but never passes through one.";

/** GAP-315 (I-21 fix pass 2): a neighbourhood's basis when a confirmed flow
 *  brings a tag into `connected`, or `feeds` / `fed_by` is not empty. It
 *  names no `route` (this mode has none) and says, per tag, which source put
 *  it there. */
const NEIGHBOURHOOD_BASIS_WITH_FLOWS =
  "Two sources. `connected` is undirected and counts both: CONFIRMED flows on the plant's process map "
  + "(a person drew it or confirmed it; proposed or dismissed flows are never used), and equipment "
  + "appearing together on the same drawing page, or an off-page continuation reference (sheet-level "
  + "connectivity, not valve-by-valve line tracing). `confirmed_flows.connected_through_flow` names the "
  + "tags in `connected` that only a confirmed flow brings that close; every other tag is that close on "
  + "sheet co-occurrence alone. Direction comes from confirmed flows only (`confirmed_flows.feeds` / "
  + "`fed_by`). A UNIT<code> tag is a whole operating unit (a Site Codebook unit), not a piece of "
  + "equipment: `connected` never passes through one, and `feeds` / `fed_by` name one and stop there. "
  + "Intermediate components are only listed once line geometry is captured.";

/** ING-10 residual: the most tag-occurrence rows one trace reads. The read is
 *  paged to the end or to here (readTagIndex, by key); past it the document
 *  the ceiling cut is dropped whole and the trace says it is partial. */
export const LINE_GRAPH_ROW_CEILING = 50_000;

/** ING-10 residual (I-21 fix pass): the wall clock one trace may spend
 *  paging the tag index. Each page is a fresh query (an org filter and a
 *  sort), and the run around it has its own budget (app/api/orchestrator
 *  LOOP_BUDGET_MS, 75 s). No new data page starts past this; the read stops
 *  there and the trace says it is partial, exactly as at the row ceiling.
 *  The one exception (fix pass 2): when the page before came back short,
 *  the read is most likely over, and the page that would close it is still
 *  asked for — once — so a read that is whole is never called partial.
 *  The confirmed-flow read runs beside it on the same clock (fix pass 3:
 *  flowsToLineEdges' `deadline`); past it, that read fails and is said. */
export const LINE_GRAPH_READ_BUDGET_MS = 10_000;

/** I-21 fix pass 4: the wall clock the graph's readability checks (which
 *  sheets the caller may open, and which flow sources are the org's own) may
 *  spend once the reads are done. No check chunk starts past it: the ids not
 *  checked by then are treated as unreadable (fail closed) and the trace says
 *  it is partial. It runs from the reads' end, not the trace's start, so a
 *  read that used its whole budget (and its closing page) still has the rows
 *  it read checked. One graph load is then bounded by the two budgets, plus a
 *  page and a chunk already running when each runs out. */
export const LINE_GRAPH_CHECK_BUDGET_MS = 5_000;

/** What loadLineGraph built, and what it could not include. */
interface LineGraph {
  /** Confirmed-flow edges first, then the sheet co-occurrence edges. When a
   *  confirmed flow and co-occurrence join the SAME pair, the flow is the
   *  step a route names (it comes first in that pair's adjacency), and the
   *  trace still cites the sheets that carry the pair (`also_on_sheet`, and
   *  `drawings`: fix pass 3). Between two different routes of equal length,
   *  breadth-first order decides, not the basis: flows in id order, then the
   *  sheets in (document, page, tag) order. Whenever the route taken is not
   *  the one the sheets alone give, the trace names that one too
   *  (`sheet_route`: fix pass 4). */
  edges: LineEdge[];
  /** The trace keys of the unit ends among the flow edges (unitTraceTag). */
  units: ReadonlySet<string>;
  /** The tag index was not read to the end: past LINE_GRAPH_ROW_CEILING
   *  rows ("ceiling"), past LINE_GRAPH_READ_BUDGET_MS ("time"), or a page
   *  failed after earlier pages read ("failed", fix pass 4). */
  partial: "ceiling" | "time" | "failed" | null;
  /** The message of the page that failed, when `partial` is "failed". */
  partialFailure: string | null;
  /** The readability checks ran past their time (fix pass 4): the ids not
   *  checked were treated as unreadable, so some sheets were not walked. */
  checksOutOfTime: boolean;
  /** The tag index read failed on its first page: the graph holds confirmed
   *  flows only. */
  indexUnavailable: string | null;
  /** Confirmed flows could not be read (a failed read, never a database
   *  without the flow table — that traces exactly as before). */
  flowsUnavailable: string | null;
  flowsTruncated: boolean;
}

/**
 * GAP-315 (I-21 fix pass): the edges an UNDIRECTED walk — a route, or the
 * `connected` neighbourhood — may take. A UNIT<code> node is a whole
 * operating unit, not a piece of equipment, and every asset it feeds or is
 * fed by joins it: walked through, it would put any two such assets two runs
 * apart, and a route through it would displace the drawn one. So a confirmed
 * flow with a unit end is walked only when that unit is the trace's own start
 * or end. Without unit-ended flows this is every edge, unchanged.
 */
function equipmentWalk(graph: LineGraph, ...ends: string[]): LineEdge[] {
  if (graph.units.size === 0) return graph.edges;
  const own = new Set(ends.map(normalizeTag));
  const passable = (tag: string) => !graph.units.has(tag) || own.has(tag);
  return graph.edges.filter((e) => e.basis !== "confirmed_flow"
    || (passable(normalizeTag(e.from)) && passable(normalizeTag(e.to))));
}

/**
 * IRLS-11 (I-21 fix pass 2): the ids among `knowledgeDocIds` that are not
 * this org's own knowledge documents. unreadableMirrors looks a document up by
 * id alone, so a legacy confirmed flow (20261155 counted such rows and kept
 * them) that cites another workspace's upload would pass it, be walked, and
 * name that document's id in `drawings`. A flow citing one is not walked. A
 * failed read names every id (fails closed, as unreadableMirrors does). With
 * a budget (fix pass 4), no chunk starts past its deadline, and the ids not
 * looked up by then are named too (fail closed).
 */
async function notOrgsOwn(orgId: string, knowledgeDocIds: string[], budget?: CheckBudget): Promise<Set<string>> {
  const ids = [...new Set(knowledgeDocIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  try {
    const own = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      if (budgetSpent(budget)) break;
      const { data, error } = await supabaseAdmin
        .from("knowledge_documents").select("id")
        .eq("org_id", orgId).in("id", ids.slice(i, i + 200));
      if (error) throw error;
      for (const d of (data ?? []) as Array<{ id: string }>) own.add(d.id);
    }
    return new Set(ids.filter((id) => !own.has(id)));
  } catch { return new Set(ids); }
}

/** One tag occurrence the line trace reads (knowledge_page_entities). */
type TagRow = { id: string; document_id: string; page: number; kind: string; tag: string };

/** A value inside a PostgREST `.or()` list, as one quoted literal: a comma,
 *  a parenthesis or a dot in it never splits the list (ORCH-6). */
const orLiteral = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The rows after `r` in (document_id, page, tag, id) order, as a keyset
 *  `.or()` list: a later document; or the same document and a later page; or
 *  the same page and a later tag; or the same tag and a later id. */
function tagRowsAfter(r: TagRow): string {
  const d = orLiteral(r.document_id);
  const p = Number(r.page);
  const t = orLiteral(r.tag);
  return [
    `document_id.gt.${d}`,
    `and(document_id.eq.${d},page.gt.${p})`,
    `and(document_id.eq.${d},page.eq.${p},tag.gt.${t})`,
    `and(document_id.eq.${d},page.eq.${p},tag.eq.${t},id.gt.${orLiteral(r.id)})`,
  ].join(",");
}

/**
 * ING-10 residual: the org's tag index, read whole or said not to be.
 *
 * Paged by KEY on the read's whole order (I-21 fix pass 3): each page asks
 * for the rows after the last one the page before returned, in (document_id,
 * page, tag, id) order. A sheet re-indexed while the trace reads (its rows
 * deleted, then inserted again) never shifts a later sheet's rows out of the
 * pages, as an OFFSET page would (lib/knowledgeAskGuards `readAllByKey` says
 * the same of offsets), and no page re-reads the rows before it. The order
 * keeps a sheet's rows together and in page order, so a read stopped part
 * way cuts one sheet, which loadLineGraph drops whole; and edge order (which
 * breaks a tie between equal-length routes) follows the tags.
 *
 * A short page is not taken as the last (a project max-rows may sit below
 * READ_PAGE): the read ends on an empty page, past LINE_GRAPH_ROW_CEILING
 * rows ("ceiling"), or at LINE_GRAPH_READ_BUDGET_MS ("time": no page starts
 * past it, save the one closing page after a short one). A failed page
 * returns its error beside the rows read before it: on the first page,
 * loadLineGraph says the index could not be read; on a later one, it treats
 * the failure as a stop (fix pass 4).
 */
async function readTagIndex(orgId: string, startedAt: number):
  Promise<{ rows: TagRow[]; error: PgErr | null; stop: "ceiling" | "time" | null }> {
  const rows: TagRow[] = [];
  let after: TagRow | null = null;
  let shortBefore = false;
  let closingAsked = false;
  for (let n = 0; n < 10_000; n++) {
    if (after && Date.now() - startedAt > LINE_GRAPH_READ_BUDGET_MS) {
      if (!shortBefore || closingAsked) return { rows, error: null, stop: "time" };
      closingAsked = true;
    }
    let q = supabaseAdmin
      .from("knowledge_page_entities")
      .select("id, document_id, page, kind, tag")
      .eq("org_id", orgId)
      .in("kind", TAG_ENTITY_KINDS as unknown as string[]);
    // The `gte` is implied by the `or` and changes no row: it is the range
    // bound an index on the order can seek to.
    if (after) q = q.gte("document_id", after.document_id).or(tagRowsAfter(after));
    const { data, error } = await q
      .order("document_id", { ascending: true }).order("page", { ascending: true })
      .order("tag", { ascending: true }).order("id", { ascending: true })
      .limit(READ_PAGE);
    if (error) return { rows, error, stop: null };
    const batch = (data ?? []) as TagRow[];
    if (batch.length === 0) return { rows, error: null, stop: null };
    rows.push(...batch);
    if (rows.length > LINE_GRAPH_ROW_CEILING) return { rows, error: null, stop: "ceiling" };
    shortBefore = batch.length < READ_PAGE;
    after = batch[batch.length - 1];
  }
  return { rows, error: null, stop: "ceiling" };
}

/**
 * Build the connectivity graph from what extraction actually captured.
 *
 * Equipment on the same drawing page is connected on that page; an off-page
 * reference is an edge to another sheet. It is not line geometry, and the
 * tool result says so — an approximation labelled honestly beats an exact
 * answer that doesn't exist.
 *
 * GAP-315: the plant's CONFIRMED process flows are merged in
 * (lib/processFlows flowsToLineEdges — confirmed rows only, never a proposal
 * or a dismissed row), each edge naming its basis. A database without the
 * flow table traces exactly as before. Nothing here writes: a flow-derived
 * edge answers a question and never drives a hold or an MOC.
 */
async function loadLineGraph(ctx: ToolContext): Promise<LineGraph> {
  const startedAt = Date.now();
  const [read, flows] = await Promise.all([
    readTagIndex(ctx.orgId, startedAt),
    // The flow read and its end resolution are bounded on the same clock
    // (fix pass 3): past it, the read fails and the trace says so.
    flowsToLineEdges(ctx.orgId, supabaseAdmin, { deadline: startedAt + LINE_GRAPH_READ_BUDGET_MS }),
  ]);
  // A page that fails after earlier pages read is a stop, like the ceiling
  // or the time budget (fix pass 4): the rows read are kept, the sheet the
  // last of them is in is dropped whole, and the answer says PARTIAL, naming
  // the failure. A failure on the first page leaves no row: the graph is the
  // confirmed flows alone, and the answer says the index could not be read.
  const readFailure = read.error ? (read.error.message || "the read failed") : null;
  const firstPageFailed = readFailure !== null && read.rows.length === 0;
  let rowsAll: TagRow[] = read.rows;
  const partial: LineGraph["partial"] = readFailure !== null ? (firstPageFailed ? null : "failed") : read.stop;
  if (partial) {
    // Past the ceiling the first row beyond it names the document the
    // ceiling cut; stopped on time or by a failed page, the last row read
    // names the document that may go on. Its rows inside are dropped, so
    // every sheet walked is walked whole.
    const kept = rowsAll.slice(0, LINE_GRAPH_ROW_CEILING);
    const cut = rowsAll[LINE_GRAPH_ROW_CEILING]?.document_id ?? kept[kept.length - 1]?.document_id ?? null;
    rowsAll = kept.filter((r) => r.document_id !== cut);
  }

  // SURF-7 / IEDGE-2: the graph is built only from sheets the caller may read
  // — a trace must not walk a drawing they cannot open. A confirmed flow
  // read off a sheet the caller cannot open is not walked either, nor one
  // that cites another workspace's document (IRLS-11: a legacy row
  // 20261155 kept); a hand-drawn flow (no source sheet) is the org's shared
  // map. Both checks are bounded in time (fix pass 4): no lookup starts more
  // than LINE_GRAPH_CHECK_BUDGET_MS after the reads ended, and an id not
  // checked by then is not walked (fail closed); the answer says PARTIAL.
  const flowDocs = [...new Set(flows.edges.map((e) => e.drawingId).filter((d): d is string => !!d))];
  const checks: CheckBudget = { deadline: Date.now() + LINE_GRAPH_CHECK_BUDGET_MS, outOfTime: false };
  const [hidden, foreign] = await Promise.all([
    unreadableMirrors(ctx, [...new Set([...rowsAll.map((r) => r.document_id), ...flowDocs])], checks),
    notOrgsOwn(ctx.orgId, flowDocs, checks),
  ]);

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
        edges.push({ lineId: `p${page}`, from: eq[i], to: eq[j], drawingId: documentId, basis: "same_sheet" });
      }
      for (const ref of new Set(slot.refs)) {
        edges.push({ lineId: ref, from: eq[i], to: ref, drawingId: documentId, offPage: true, basis: "same_sheet" });
      }
    }
  }
  const flowEdges = flows.edges.filter((e) => !e.drawingId || (!hidden.has(e.drawingId) && !foreign.has(e.drawingId)));
  return {
    edges: [...flowEdges, ...edges],
    units: new Set(flows.unitNodes),
    partial,
    partialFailure: partial === "failed" ? readFailure : null,
    checksOutOfTime: checks.outOfTime,
    indexUnavailable: firstPageFailed ? readFailure : null,
    flowsUnavailable: flows.state === "error" ? (flows.error ?? "the read failed") : null,
    flowsTruncated: flows.truncated,
  };
}

/** I-21 fix pass 4: the graph, read once per run. A run's ToolContext is one
 *  object for all its steps (app/api/orchestrator/route.ts builds it once
 *  and lib/orchestrator/loop.ts passes it to every call), and the graph
 *  depends on nothing else: the org, and the caller's principal through the
 *  readability checks. So a run that traces several pairs reads the tag
 *  index, the flows and the checks once, and each later trace answers from
 *  that graph, its PARTIAL or unavailable notes included. A load that throws
 *  is not kept, so the next trace reads again. */
const lineGraphs = new WeakMap<ToolContext, Promise<LineGraph>>();
function lineGraphFor(ctx: ToolContext): Promise<LineGraph> {
  const kept = lineGraphs.get(ctx);
  if (kept) return kept;
  const load = loadLineGraph(ctx);
  lineGraphs.set(ctx, load);
  load.catch(() => { if (lineGraphs.get(ctx) === load) lineGraphs.delete(ctx); });
  return load;
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

    // Authority (DEC-72, the plan default): any active member may
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

    // The bell row IS the delivery, so it is written HERE, on the service
    // role, and checked. It used to ride emit(), which writes through the
    // shared client — in /execute (a server route with no browser session)
    // that is the anon client: RLS refuses its insert (notifications_org_insert
    // needs auth.uid() to be an active member) and emit() swallows the
    // refusal, so "sent" was reported for a message nobody received. A
    // refused insert is a failure, never "sent": /execute records
    // AI_ACTION_FAILED and gives the claim back, so the person can retry.
    const recipient = String(args.user_id);
    const title = `About ${d.document_number}`;
    const body = String(args.message);
    const link = `/documents/${d.library_id}?doc=${args.document_id}`;
    const { error: bellErr } = await supabaseAdmin.from("notifications").insert({
      org_id: ctx.orgId, user_id: recipient, kind: "orchestrator_message",
      title, body, link,
      resource_type: "document", resource_id: String(args.document_id),
      actor_user_id: ctx.userId, actor_name: ctx.actorName, metadata: null,
    });
    if (bellErr) {
      return { data: { error: "The notification could not be sent — nothing reached them. Try again." } };
    }
    // The email copy goes through the dispatcher (the recipient's email
    // preferences and the 60-second dedupe apply as everywhere else), with
    // the shared client bound to the service role for THIS call only
    // (lib/serverClientScope — the intake door's pattern). The bell row has
    // already delivered the message, so a failure here is logged, not
    // reported as a failed send: a retry would deliver the message twice.
    try {
      const [{ emit }, { runWithServerClient }] = await Promise.all([
        import("@/lib/notify/dispatch"),
        import("@/lib/serverClientScope"),
      ]);
      await runWithServerClient(supabaseAdmin, () => emit({
        orgId: ctx.orgId, category: "watched", kind: "orchestrator_message",
        title, body, link,
        resource: { type: "document", id: String(args.document_id) },
        actorUserId: ctx.userId, actorName: ctx.actorName,
        audience: { involved: [recipient] },
        channels: ["email"],
      }));
    } catch (e) {
      console.error("[orchestrator] notify_personnel: the email copy was not queued (the in-app notification was delivered):", e instanceof Error ? e.message : e);
    }
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

/** Did a library's drawing audit file this row? Its details name the
 *  library, or the knowledge document it judged — the key 20261124 backfills
 *  library_id from. On the pre-20261124 key such a row is refused
 *  (LIBRARY_ROW_ON_LEGACY_KEY); after 20261124 the org-wide read returns one
 *  only when its mirror is gone, and its details are kept (keptDetails). */
function filedByLibrary(details: unknown): boolean {
  const k = (details as { knowledgeDocumentId?: unknown } | null)?.knowledgeDocumentId;
  return !!libraryOf(details) || (typeof k === "string" && k.length > 0);
}

/** What of a stored row's audit_details a confirmed record keeps: all of
 *  it — findings, knowledge document, library, coverage, set — except the
 *  provisional marker and its waiting positions. A person's confirmed
 *  verdict at or above what the row settled (lowersStored) settles it, as a
 *  settled computation does in the drawing route (replaceDecision: a
 *  settled `next` replaces a provisional row). */
function keptDetails(details: unknown, opts: { dropWaiting?: boolean } = {}): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const { provisional: _provisional, waitingFindings: waiting, ...kept } = details as Record<string, unknown>;
  // A confirmed verdict BELOW the stored row's status (at or above what it
  // settled) does not confirm the findings the row was still waiting on —
  // they are dropped, never kept unmarked as if settled (integration fix,
  // 2026-10-01). At or above the stored status the person confirms them.
  if (opts.dropWaiting && waiting && typeof waiting === "object" && !Array.isArray(waiting)) {
    for (const [list, at] of Object.entries(waiting as Record<string, unknown>)) {
      const items = kept[list];
      if (!Array.isArray(items) || !Array.isArray(at)) continue;
      const drop = new Set(at.filter((i): i is number => typeof i === "number"));
      kept[list] = items.filter((_, i) => !drop.has(i));
    }
  }
  return kept;
}

/** Said when sheet_number or revision is blank. */
const BLANK_KEY = "sheet_number and revision are required — a revision code, not blank. Nothing was recorded.";

/** Said when the only row at this key is a library's (before 20261124). */
const LIBRARY_ROW_ON_LEGACY_KEY =
  "This sheet's record at this revision belongs to a library's drawing audit, and this database cannot keep an "
  + "org-wide record beside it until migration 20261124 is applied. Nothing was recorded — record it from that "
  + "library's drawing audit, or ask again after 20261124.";

/** Would writing `status` over the stored ORG-WIDE verdict lower what it
 *  settled? The drawing layer's own rule (lib/drawingAuditLog
 *  replaceDecision, RANK): a known revision's verdict is never lowered; a
 *  provisional row's floor is what it settled. (On the pre-20261124 key a
 *  row a library filed is never written at all — LIBRARY_ROW_ON_LEGACY_KEY.)
 *  Returns the refusal, or null to write. */
function lowersStored(
  stored: { status: string; revision_code: string; audit_details: unknown } | null,
  status: AuditStatus,
): string | null {
  if (!stored) return null;
  const provisional = storedProvisional(stored.audit_details);
  const decision = replaceDecision(
    { revision_code: stored.revision_code, status: stored.status, provisional },
    { status },
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
    { name: "document_id", type: "string", description: "The controlled document's UUID, when known (from find_documents)." },
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
    const sheet = String(args.sheet_number ?? "");
    const revision = String(args.revision ?? "");
    // A verdict is recorded against a sheet AT a revision. A blank one
    // (validateParams trims " " to "") would file an org-wide row under the
    // unknown revision, where the latest verdict wins (replaceDecision) and a
    // lower one replaces a higher one. A person has no reason to record that.
    if (!sheet.trim() || !revision.trim()) {
      return { data: { error: BLANK_KEY } };
    }
    // Never lower a verdict already settled for this key (DEC-68) — checked
    // before proposing, and again when the confirmation runs.
    const stored = await storedOrgWideVerdict(ctx.orgId, sheet, revision);
    if ("error" in stored) return { data: { error: stored.error } };
    // Before 20261124 the org-wide key is the only key, and the row on it may
    // be a library's: writing over it — at any severity — would replace its
    // library, findings and provisional marker with this note, and
    // 20261124's backfill would then file the library's verdict as org-wide
    // (DWG-6 / DEC-68: one scope's verdict never overwrites another's). It
    // is refused, before proposing and again at execute.
    if (stored.legacy && stored.row && filedByLibrary(stored.row.audit_details)) {
      return { data: { error: LIBRARY_ROW_ON_LEGACY_KEY, kept: stored.row.status } };
    }
    const lowers = lowersStored(stored.row, status);
    if (lowers) return { data: { error: lowers, kept: stored.row?.status ?? null } };

    // ORCH-11: what was found travels IN the proposal — the same object the
    // fingerprint is computed over, stored, and executed — so the confirmed
    // record keeps the finding instead of an empty note. Cut, then trimmed:
    // /execute re-validates the stored value (validateParams trims), so a
    // cut that ended on a space would re-fingerprint differently there and
    // the confirmation would never match.
    const details = typeof args.details === "string" ? args.details.slice(0, 2000).trim() : "";
    // …and the record names the controlled document it is about, as the
    // drawing route's rows do (verdictRows): the one given, if the caller may
    // read it; otherwise the single readable document numbered exactly as the
    // sheet; otherwise none.
    let documentId: string | null = null;
    if (typeof args.document_id === "string" && args.document_id) {
      const { data: doc } = await supabaseAdmin
        .from("documents").select("id").eq("id", args.document_id).eq("org_id", ctx.orgId).maybeSingle();
      if (!doc || !(await readableIds(ctx, [args.document_id])).has(args.document_id)) {
        return { data: { error: "No such document in this org." } };
      }
      documentId = args.document_id;
    } else {
      const { data: docs } = await supabaseAdmin
        .from("documents").select("id").eq("org_id", ctx.orgId).eq("document_number", sheet).limit(2);
      const ids = ((docs ?? []) as Array<{ id: string }>).map((d) => d.id);
      if (ids.length === 1 && (await readableIds(ctx, ids)).has(ids[0])) documentId = ids[0];
    }
    const params = {
      sheet_number: args.sheet_number, revision: args.revision, status,
      ...(details ? { details } : {}),
      ...(documentId ? { document_id: documentId } : {}),
    };
    const gate = proposal(
      "log_audit_completion",
      `Record ${args.sheet_number} rev ${args.revision} as ${status}${details ? ` — “${details.length > 160 ? `${details.slice(0, 160)}…` : details}”` : ""}`,
      params, ctx,
    );
    if (gate) return gate;

    // An ORG-WIDE row (library_id NULL) on 20261124's key; before 20261124,
    // the org-wide key that database has. document_id is sent only when it
    // resolved: an upsert over an existing row then keeps the document that
    // row already names instead of overwriting it with NULL (ORCH-11).
    // audit_details is MERGED over the stored row's, never replaced: after
    // 20261124 the org-wide row may be one a library's drawing audit filed
    // whose mirror is gone (the backfill left library_id NULL), and its
    // findings, knowledge document and coverage are the only copy
    // (keptDetails). Re-read at execute, so it is what is there then.
    const row = {
      org_id: ctx.orgId, sheet_number: sheet,
      ...(documentId ? { document_id: documentId } : {}),
      revision_code: revision, status,
      audited_at: new Date().toISOString(),
      audit_details: {
        ...keptDetails(stored.row?.audit_details, {
          dropWaiting: !!stored.row && (RANK[status as AuditStatus] ?? 0) < (RANK[stored.row.status as AuditStatus] ?? 0),
        }),
        note: details, by: ctx.userId, byName: ctx.actorName, source: "orchestrator",
      },
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
