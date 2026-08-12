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
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import type { ParamSpec } from "@/lib/orchestrator/protocol";
import { tracePath, traceNeighbourhood, normalizeTag, type LineEdge } from "@/lib/pidTrace";

export interface ToolContext {
  orgId: string;
  userId: string;
  role: string;
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

const CONTROLLER_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];

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
    const { data } = await supabaseAdmin
      .from("documents")
      .select("id, document_number, title, rev, status, library_id, updated_at")
      .eq("org_id", ctx.orgId)
      // PILLAR A. `ai_excluded` is the per-document carve-out a controller sets
      // when a document must stay invisible to anything automated. It is
      // honoured here explicitly because this code runs on the service-role
      // key, where RLS would not stop us.
      .eq("ai_excluded", false)
      .or(`document_number.ilike.%${q}%,title.ilike.%${q}%`)
      .neq("status", "Archived")
      .order("updated_at", { ascending: false })
      .limit(LIMIT);
    return {
      data: {
        matches: (data ?? []).map((d) => {
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
    return {
      data: {
        passages: (data ?? []).map((r: Record<string, unknown>) => ({
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
    const { data } = await supabaseAdmin
      .from("assets")
      .select("id, tag, description, unit_code")
      .eq("org_id", ctx.orgId).eq("archived", false)
      .or(`unit_code.ilike.%${u}%,description.ilike.%${u}%`)
      .limit(100);
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
      .select("page, context_snippet, mention_count, knowledge_documents(name)")
      .eq("org_id", ctx.orgId).eq("asset_id", (match as { id: string }).id)
      .order("mention_count", { ascending: false })
      .limit(LIMIT);
    return {
      data: {
        tag: (match as { tag: string }).tag,
        found: true,
        mentions: (data ?? []).map((m) => {
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
    // RLS is the real gate; this reports what the caller can already see, so
    // a "no" here is the same "no" the database would give.
    const { data } = await supabaseAdmin
      .from("documents").select("id, document_number, status, org_id")
      .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
    if (!data) return { data: { readable: false, editable: false, note: "Not visible to this user." } };
    // A document can carry several open holds at once (one per reason), so
    // this asks "any" rather than "the" — maybeSingle() would throw on the
    // second one and report a permission answer as an error.
    const { data: holds } = await supabaseAdmin
      .from("document_holds").select("id, reason")
      .eq("document_id", String(args.document_id)).is("released_at", null).limit(5);
    const hold = (holds ?? []).length > 0;
    return {
      data: {
        readable: true,
        editable: CONTROLLER_ROLES.includes(ctx.role) && !hold,
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
    const { data, error } = await q.order("audited_at", { ascending: false }).limit(5);
    if (error) return { data: { audited: false, note: "Audit memory isn't installed yet." } };
    const rows = data ?? [];
    // Without a revision in the question, prior audits are history, not an
    // answer — the sheet may well have been revised since.
    const recommendation = rows.length === 0
      ? (args.revision ? "Not audited at this revision — go ahead." : "Never audited — go ahead.")
      : args.revision
        ? "Already audited at this revision. Skip it unless the drawing has been revised since."
        : `Audited before (latest: rev ${String((rows[0] as { revision_code: string }).revision_code)}). `
          + "Ask which revision is in front of you before deciding.";
    return { data: { audited: rows.length > 0, history: rows, recommendation } };
  },
};

const tracePidLines: ToolDef = {
  name: "trace_pid_lines",
  description:
    "SHEET-LEVEL connectivity: which drawings connect two pieces of equipment, following "
    + "off-page references across sheets. Use for multi-drawing routes and 'which sheets is "
    + "this line on'. For following the drawn line itself on one sheet, use "
    + "trace_line_on_drawing — that one measures pixels; this one only knows co-occurrence.",
  params: [
    { name: "start_tag", type: "string", required: true, description: "Equipment tag to start from." },
    { name: "end_tag", type: "string", description: "Equipment tag to reach. Omit to list neighbours." },
    { name: "hops", type: "number", description: "Neighbourhood radius when no end tag (default 2)." },
  ],
  async run(args, ctx) {
    const edges = await loadLineGraph(ctx.orgId);
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
      const hits = [...byPage].filter(([, tags]) => tags.size === 2).map(([k]) => k);
      if (hits.length > 0) {
        const ids = [...new Set(hits.map((k) => k.split("#")[0]))];
        const { data: docs } = await supabaseAdmin
          .from("knowledge_documents").select("id, name").in("id", ids);
        const names = new Map(((docs ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
        sameSheet = hits.map((k) => {
          const [documentId, page] = k.split("#");
          return { sheet: names.get(documentId) ?? "Sheet", page: Number(page) };
        }).filter((x) => x.sheet !== "Sheet" || true);
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
async function loadLineGraph(orgId: string): Promise<LineEdge[]> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("document_id, page, kind, tag")
    .eq("org_id", orgId)
    .in("kind", TAG_ENTITY_KINDS as unknown as string[])
    .order("document_id", { ascending: true })
    .limit(20000);
  if (error) return [];

  const byPage = new Map<string, { equipment: string[]; refs: string[] }>();
  for (const row of (data ?? []) as Array<{ document_id: string; page: number; kind: string; tag: string }>) {
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
      .from("documents").select("id, document_number, title, library_id, checked_out_by, checked_out_by_name")
      .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
    if (!doc) return { data: { error: "No such document in this org." } };
    const d = doc as {
      document_number: string; library_id: string;
      checked_out_by: string | null; checked_out_by_name: string | null;
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
    if (!CONTROLLER_ROLES.includes(ctx.role)) {
      return { data: { error: "This user's role can't check documents out." } };
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
    const d = doc as { document_number: string; library_id: string };

    // Membership check before the proposal, not after: an org id in a
    // parameter is not proof the recipient is in the org.
    const { data: member } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", ctx.orgId).eq("uid", String(args.user_id)).eq("status", "active").maybeSingle();
    if (!member) return { data: { error: "That user isn't an active member of this org." } };

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
      actorUserId: ctx.userId, actorName: "Document controller",
      audience: { involved: [String(args.user_id)] },
    }).catch(() => undefined);
    return { data: { status: "sent" } };
  },
};

const logAuditCompletion: ToolDef = {
  name: "log_audit_completion",
  description:
    "Record that a drawing sheet was audited at a revision, so it isn't audited again. "
    + "Requires the user's confirmation.",
  writes: true,
  params: [
    { name: "sheet_number", type: "string", required: true, description: "Sheet or drawing number." },
    { name: "revision", type: "string", required: true, description: "Revision code audited." },
    { name: "status", type: "string", required: true, description: "passed | broken_connectors | flagged | skipped" },
    { name: "details", type: "string", description: "What was found." },
  ],
  async run(args, ctx) {
    const status = String(args.status);
    if (!["passed", "broken_connectors", "flagged", "skipped"].includes(status)) {
      return { data: { error: "status must be passed, broken_connectors, flagged, or skipped." } };
    }
    const params = { sheet_number: args.sheet_number, revision: args.revision, status };
    const gate = proposal(
      "log_audit_completion",
      `Record ${args.sheet_number} rev ${args.revision} as ${status}`, params, ctx,
    );
    if (gate) return gate;

    const { error } = await supabaseAdmin.from("drawing_audit_logs").upsert({
      org_id: ctx.orgId, sheet_number: String(args.sheet_number),
      revision_code: String(args.revision), status,
      audit_details: { note: args.details ?? "", by: ctx.userId },
    }, { onConflict: "org_id,sheet_number,revision_code" });
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
