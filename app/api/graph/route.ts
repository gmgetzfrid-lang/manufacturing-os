// /api/graph — the org graph, assembled on the server for ONE caller
// (intelligence Round G, I-15; GAP-313).
//
//   GET ?orgId=<org>[&scope=unit:<code>]  →  { graph, proposals } (packed —
//   lib/orgGraph packGraphPayload / unpackGraphPayload)
//
// The graph page's one request. Before this route the page assembled the map
// in the browser: about fourteen requests for a typical org, up to ~56 at the
// caps, each a round trip from the browser. Here the same reads run server to
// database, and the page receives one payload.
//
// WHOSE MAP (DEC-90 ruling for I-15; GAP-313's "Do not"):
//   * Every read is the CALLER's: lib/orgGraph buildOrgGraphForCaller runs
//     inside runWithServerClient(callerScopedClient(req)) — the caller's own
//     JWT on the anon key — so documents RLS (documents_acl_select →
//     node_visible), the relation's read rail (DACL-11) and every other
//     table's policy decide exactly as they do for the client assembly. The
//     service role reads nothing of the map.
//   * On top of that, the app's document predicate for this caller:
//     lib/knowledgeAccess loadPrincipal + readableControlledDocIds
//     (lib/permissions canReadNode — the one predicate, no second walk). A
//     controller is never refused by it, so a controller's map is the one the
//     client assembly gives them. A member sees only the documents the
//     predicate lets them read; a document it refuses is not drawn, and no
//     link to it is drawn or counted.
//   * The predicate failing to decide (the access landscape or the documents'
//     rows cannot be read) FAILS CLOSED: 503, `accessUnchecked`, no map —
//     never a map the predicate did not check. The page says so.
//   * Never cached across callers: nothing is kept here between requests,
//     and the answer is `Cache-Control: private, no-store`.
//
// The pending proposal pairs (lib/linkProposals readPendingProposalPairs —
// the reader's queue under proposed_links RLS, LNK-4) ride in the same
// payload, read as the caller; a pair naming a document the predicate
// refused is dropped. Their read failing is said in the payload (GM-7's
// three answers), never a failed map.
//
// THE SIZE OF THE ANSWER (fix pass). It is one buffered body, and the
// platform refuses one past ~4.5 MB. lib/orgGraph fitGraphPayload packs it
// (an edge names its ends by position — nothing is dropped; the page unpacks
// it) and holds it to GRAPH_PAYLOAD_BUDGET: past that the proposal pairs are
// left out (the payload says so), and a map past it even alone is refused
// with the reason — 413, `tooLarge` — never handed to the platform to cut.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { runWithServerClient } from "@/lib/serverClientScope";
import {
  loadPrincipal, readableControlledDocIds, PrincipalUnreadableError, PRINCIPAL_UNREADABLE,
} from "@/lib/knowledgeAccess";
import { buildOrgGraphForCaller, fitGraphPayload, graphTooLargeMessage } from "@/lib/orgGraph";
import { readPendingProposalPairs, type PendingPairsRead } from "@/lib/linkProposals";
import { parseScopeParam } from "@/lib/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

/** What the page says when the predicate could not decide. */
const GRAPH_ACCESS_UNCHECKED =
  "Your document access couldn't be checked just now, so the map is not drawn — rather than show documents that may not be yours to see. Try again in a moment.";

function bad(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status, headers: PRIVATE });
}

/** The predicate failed to decide: never a verdict, never a map. */
class AccessUnchecked extends Error {
  constructor(failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = "AccessUnchecked";
  }
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required", 400);
  const rawScope = req.nextUrl.searchParams.get("scope");
  const scope = rawScope ? parseScopeParam(rawScope) : null;
  if (rawScope && !scope) return bad("scope must be unit:<code>", 400);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not signed in", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not signed in", 401);

  let principal: Awaited<ReturnType<typeof loadPrincipal>>;
  try {
    principal = await loadPrincipal(orgId, user.id);
  } catch (e) {
    if (e instanceof PrincipalUnreadableError) return bad(PRINCIPAL_UNREADABLE, 503, { accessUnchecked: true });
    // Any other throw (integrator fix pass): the caller's access was not
    // decided either, so it fails closed the same way — 503, accessUnchecked,
    // private and uncached, with the route's sentence — never a bare 500
    // without the headers.
    console.error("[api/graph] the caller's access could not be loaded:", (e as Error)?.message ?? String(e), { orgId });
    return bad(GRAPH_ACCESS_UNCHECKED, 503, { accessUnchecked: true });
  }
  if (!principal) return bad("Not a member of this workspace", 403);
  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);

  // The caller's predicate, asked once per assembly (the documents read).
  const readable = async (ids: string[]): Promise<Set<string>> => {
    try {
      return await readableControlledDocIds(principal, ids);
    } catch (e) {
      throw new AccessUnchecked(e);
    }
  };

  try {
    const [built, proposals] = await runWithServerClient(caller, () => Promise.all([
      buildOrgGraphForCaller(orgId, { scope, readable }),
      readPendingProposalPairs(orgId).catch((e: unknown): PendingPairsRead => ({
        pairs: [], total: null, capped: false, error: (e as Error)?.message || "the read failed",
      })),
    ]));
    const refused = built.refused;
    const pairs = refused.size === 0 ? proposals.pairs
      : proposals.pairs.filter((p) => !refused.has(p.documentId) && !refused.has(p.targetDocumentId));
    const fitted = fitGraphPayload({ graph: built.graph, proposals: { ...proposals, pairs } });
    if ("tooLarge" in fitted) {
      console.error("[api/graph] the map is past the answer budget:", fitted.bytes, { orgId });
      return bad(graphTooLargeMessage(fitted.bytes), 413, { tooLarge: true });
    }
    return new NextResponse(fitted.body, {
      status: 200, headers: { ...PRIVATE, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof AccessUnchecked) {
      console.error("[api/graph] the document predicate could not decide:", e.message, { orgId });
      return bad(GRAPH_ACCESS_UNCHECKED, 503, { accessUnchecked: true });
    }
    // A required read failed (documents, libraries, a link table): the
    // client assembly threw the same sentence (GM-4).
    return bad((e as Error)?.message || "The map could not be assembled.", 500);
  }
}
