// /api/transmittal/register — DIST-17 (document-control P27): the transmittal
// register, read by the server and filtered for the signed-in viewer.
//
//   GET ?orgId=<org>[&id=<transmittal>]  → { transmittals: Transmittal[] }
//   DIST-18 limb (a) (document-control P29) — the other browser readers'
//   slices, each through the same redaction (one slice per request):
//     &documentId=<doc>   the Inspector's trail: rows listing it, 50 newest
//                         (none unless this viewer may read the document)
//     &projectId=<proj>   the project evidence pack: oldest first, 500
//     &q=<text>[&limit=n] global search: number / subject / recipient name /
//                         company matching, newest first, n (default 5, at
//                         most 50) — a subject withheld from this viewer is
//                         neither returned nor matched; every hit says q, as
//                         written, in a field this viewer is shown
//
// Until P27 the register (/transmittals) read every transmittal of the org
// with the member's browser client (transmittals_select, 20260910: any active
// member reads the whole row), and every row's cover sheet printed each
// item's number, title and revision — and, for a live link, the portal URL
// and QR that download the as-sent files — whatever the documents' ACL.
// Now (the integrator's rulings under DEC-90):
//   1. a transmittal's items are shown only to a member the document read
//      predicate lets read each item — lib/permissions canReadNode over the
//      full library → folder → document chain, asked through
//      lib/knowledgeAccess readableControlledDocIds (the I-12 predicate; no
//      second walk) — to its sender, and to controllers; anyone else sees
//      the transmittal and its non-identifying fields, each unreadable item
//      as "Restricted document";
//   2. the portal token is handed only to someone who may read every item;
//   — lib/transmittals redactTransmittalForViewer, on every row.
// The population is the one transmittals_select admits: active members of
// the org (loadPrincipal answers null for anyone else → 403). The same
// 1,000 newest rows, newest first, as the browser read.
//
// Fail closed: a membership or teams read that fails answers 503 "try
// again" (KACL-12 — never "not a member"); a document landscape that cannot
// be read leaves the decision undecided — the sender and controllers keep
// their full rows, everyone else's items are withheld and no token is handed
// out but to a controller, each row saying so (`viewer.accessUnchecked`).
// The REST read of the table's other columns is not narrowed here (DIST-18
// limb (b), after intelligence I-30); portal_token is no longer readable by
// client roles at all once 20261231 is pasted (DIST-18 limb (a)) — this
// route reads it with the service role and hands it out under ruling 2.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadPrincipal, readableControlledDocIds, PrincipalUnreadableError, DcLandscapeUnreadableError, PRINCIPAL_UNREADABLE,
} from "@/lib/knowledgeAccess";
import { redactTransmittalForViewer, rowToTransmittal, TRANSMITTAL_SEARCH_MAX } from "@/lib/transmittals";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DIST-18 (limb a): global search's slice — how many hits it asks for by
 *  default, the most it may ask for, and how many candidates the server
 *  reads so a viewer whose subject matches are withheld still gets hits. */
const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_CANDIDATES = 50;

/** The columns global search matches, each asked as its OWN filter. */
const SEARCH_COLUMNS = ["number", "subject", "recipient_name", "recipient_company"] as const;

/** DIST-18 (limb a): LIKE's own escaping — `\\`, `%` and `_` are literal in
 *  the pattern. The text is sent only as ONE filter value (`.ilike(col, …)`),
 *  which PostgREST never splits, and never inside `.or()`: an unquoted or()
 *  value runs to the next `,` or `)` whatever backslash precedes it, so the
 *  request text could add its own filter terms (portal_token among them) to a
 *  read made with the service role. (PostgREST reads `*` in a like value as
 *  `%`; that only widens the match on the column itself, and every hit must
 *  still say q, as written, in a field the viewer is shown — below.) */
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, "\\$&");
}
const MIGRATION_HINT =
  "Transmittals aren't set up yet — run supabase/migrations/20260717_transmittals.sql, then reload.";

function bad(msg: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: msg, ...extra }, { status });
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  const params = req.nextUrl.searchParams;
  const orgId = (params.get("orgId") ?? "").trim();
  const id = (params.get("id") ?? "").trim();
  const documentId = (params.get("documentId") ?? "").trim();
  const projectId = (params.get("projectId") ?? "").trim();
  const q = params.has("q") ? (params.get("q") ?? "").trim() : null;
  if (!UUID_RE.test(orgId)) return bad("orgId is required", 400);
  if (id && !UUID_RE.test(id)) return bad("id must be a transmittal id", 400);
  if (documentId && !UUID_RE.test(documentId)) return bad("documentId must be a document id", 400);
  if (projectId && !UUID_RE.test(projectId)) return bad("projectId must be a project id", 400);
  if (q !== null && (q.length < 2 || q.length > TRANSMITTAL_SEARCH_MAX)) return bad(`q must be 2 to ${TRANSMITTAL_SEARCH_MAX} characters`, 400);
  if ([id, documentId, projectId, q ?? ""].filter((v) => v.length > 0).length > 1) return bad("Ask for one slice at a time: id, documentId, projectId or q.", 400);
  const rawLimit = params.get("limit");
  const searchLimit = rawLimit === null ? SEARCH_DEFAULT_LIMIT : Number(rawLimit);
  if (q !== null && !(Number.isInteger(searchLimit) && searchLimit >= 1 && searchLimit <= SEARCH_MAX_LIMIT)) return bad(`limit must be 1 to ${SEARCH_MAX_LIMIT}`, 400);

  let principal: Awaited<ReturnType<typeof loadPrincipal>>;
  try {
    principal = await loadPrincipal(orgId, user.id);
  } catch (e) {
    if (e instanceof PrincipalUnreadableError) return bad(PRINCIPAL_UNREADABLE, 503, { unreadable: true });
    throw e;
  }
  if (!principal) return bad("Not a member of this workspace.", 403);
  // DIST-18 (limb a, review): the documentId slice answers only about a
  // document this viewer may read. Otherwise the list of transmittals that
  // sent a document (recipients, dates) would tell anyone who knows or
  // guesses its id that it exists and where it went — a membership oracle on
  // the service-role read that limb (b)'s database narrowing would not close.
  // The Inspector asks only for the document the viewer has open, so a
  // reader sees no change; a controller is answered before any read (DEC-43).
  if (documentId && !principal.isController) {
    let mayAsk: Set<string>;
    try {
      mayAsk = await readableControlledDocIds(principal, [documentId]);
    } catch (e) {
      if (!(e instanceof DcLandscapeUnreadableError)) throw e;
      console.warn("[transmittal/register] the document read decision could not be made — the trail is not served (fail closed)", e.message);
      return bad("Couldn't check your access to this document — try again.", 503, { unreadable: true });
    }
    if (!mayAsk.has(documentId)) return NextResponse.json({ transmittals: [] });
  }

  const base = () => supabaseAdmin.from("transmittals").select("*").eq("org_id", orgId);
  let read = base();
  let ascending = false;
  let cap = 1000;
  if (id) read = read.eq("id", id);
  if (documentId) {
    // listTransmittalsForDocument's read, as the browser made it before DIST-18.
    read = read.contains("items", JSON.stringify([{ documentId }]));
    cap = 50;
  }
  if (projectId) {
    // gatherProjectEvidence's read, as the browser made it before DIST-18.
    read = read.eq("project_id", projectId);
    ascending = true;
    cap = 500;
  }
  let reads = [read];
  if (q !== null) {
    // searchTransmittals' match (lib/globalSearch.ts before DIST-18) as one
    // read per column, each bounded to this org and carrying the text as a
    // single ilike value; merged by id below.
    const pat = `%${likeEscape(q)}%`;
    cap = Math.max(searchLimit, SEARCH_CANDIDATES);
    reads = SEARCH_COLUMNS.map((col) => base().ilike(col, pat));
  }
  const answers = await Promise.all(reads.map((r) => r.order("seq", { ascending }).limit(cap)));
  const error = answers.find((a) => a.error)?.error ?? null;
  if (error) {
    const missing = error.code === "42P01" || /relation .*transmittals.* does not exist/i.test(error.message ?? "");
    if (missing) return bad(MIGRATION_HINT, 404, { missingTable: true });
    console.error("[transmittal/register] the register read failed", error.message);
    return bad("Couldn't load the transmittal register — try again.", 500);
  }
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const a of answers) for (const r of (a.data ?? []) as Array<Record<string, unknown>>) if (!byId.has(r.id)) byId.set(r.id, r);
  let raw = [...byId.values()];
  if (q !== null) raw = raw.sort((x, y) => Number(y.seq) - Number(x.seq)).slice(0, cap);
  const rows = raw.map(rowToTransmittal);

  // One read decision for every item the rows name (a controller is answered
  // before any read — DEC-43).
  let readable: Set<string> | null = new Set();
  if (!principal.isController) {
    const docIds = [...new Set(rows.flatMap((t) => t.items.map((i) => i.documentId)).filter((d): d is string => !!d))];
    try {
      readable = await readableControlledDocIds(principal, docIds);
    } catch (e) {
      if (!(e instanceof DcLandscapeUnreadableError)) throw e;
      console.warn("[transmittal/register] the document read decision could not be made — items and portal links withheld (fail closed)", e.message);
      readable = null;
    }
  }

  const who = { uid: user.id, isController: principal.isController };
  const shown = rows.map((t) => redactTransmittalForViewer(t, who, readable));
  if (q === null) return NextResponse.json({ transmittals: shown });
  // DIST-18 (limb a): every hit says q, as written, in a field this viewer
  // is shown — a withheld subject is never an oracle, and neither is any
  // match the database made on something the viewer does not see (a NULL
  // subject included: such a row is a hit only on its number or recipient).
  const needle = q.toLowerCase();
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
  const hits = shown.filter((t) => has(t.subject) || has(t.number) || has(t.recipientName) || has(t.recipientCompany));
  return NextResponse.json({ transmittals: hits.slice(0, searchLimit) });
}
