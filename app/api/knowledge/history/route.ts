// /api/knowledge/history — the team's stored answers, re-decided per reader.
//
// POST { orgId, libraryId, action: "list" }                  → the library's
//        recent answers (the Conversations list)
// POST { orgId, libraryId, action: "search", query }          → ask memory:
//        past answers in THIS library that match the question
// POST { orgId, libraryId, action: "thread", threadId }        → reopen one
//        conversation, every turn the reader may see, in order
//
// Stored answers were built under the ASKER's ACL and carry verbatim quotes
// of what that ACL admitted. The browser no longer reads other people's rows
// at all (knowledge_questions_select, 20261120: the asker or a controller);
// everyone reaches the team's record here, where every row's citations are
// re-checked for the CURRENT reader through loadPrincipal +
// readableControlledDocIds (lib/knowledgeHistory). A row citing anything the
// reader cannot read is withheld whole, with every later turn of its
// conversation; a library answer citing no document is shown to its asker
// only. Controllers read all memory (DEC-43).
//
// How many rows were withheld is said for `list` and `thread` (a count of
// recent answers / of one conversation's turns — no query decides it) and
// NEVER for `search`: there the reader's own words pick the rows, so a count
// of matches they may not see would answer "does a restricted answer say
// X?" one phrase at a time. For the same reason a search's answer never
// depends on how many matches were withheld: it pages through the matches,
// newest first, judging each page for the reader, until it holds `limit`
// rows the reader may see or the matches run out (at most
// SEARCH_SCAN_CAP matches are looked at), and a caller's `limit` below the
// default is ignored. A fixed window trimmed after filtering answered
// differently for limit=1 and limit=25 whenever restricted matches filled
// the small window — a count of them, in coarser form.
//
// Fails CLOSED on a failed read of the stored answers, of the cited knowledge
// documents, of the controlled documents, or of the document libraries and
// folders whose ACLs decide them: an error and no rows — never an unfiltered
// answer. (The seam's own landscape read still ignores its errors, and so
// does loadPrincipal's team_members read; readableKnowledgeDocIds makes the
// libraries / folders reads first and reads the reader's teams again, each
// failure closed, until the seam's owner makes both throw.)

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import {
  citedKnowledgeDocIds, isUuid, planVisibleHistory, readableKnowledgeDocIds, type StoredAnswerRow,
} from "@/lib/knowledgeHistory";

export const runtime = "nodejs";

const COLUMNS = "id, org_id, library_id, thread_id, user_id, user_name, question, answer, citations, mode, created_at";
const CORE_COLUMNS = "id, org_id, library_id, user_id, user_name, question, answer, citations, created_at";

/** Ask memory: the default number of matches, the page it reads them in, and
 *  the most matches it will look at before answering with what it found. */
const SEARCH_DEFAULT = 5;
const SEARCH_PAGE = 100;
const SEARCH_SCAN_CAP = 500;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

/** Pre-migration databases lack thread_id / mode (20261008 / 20260912): read
 *  the core set instead of failing the whole history. */
const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /thread_id|mode/.test(e.message ?? ""));

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: unknown; libraryId?: unknown; action?: unknown; query?: unknown; threadId?: unknown; limit?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = body.orgId;
  const libraryId = body.libraryId;
  const action = body.action;
  if (!isUuid(orgId) || !isUuid(libraryId)) return bad("orgId and libraryId are required");
  if (action !== "list" && action !== "search" && action !== "thread") return bad("Unknown action");

  let principal;
  try { principal = await loadPrincipal(orgId, user.id); } catch { principal = null; }
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data: lib, error: libErr } = await supabaseAdmin
    .from("knowledge_libraries").select("id").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (libErr) return bad(`Couldn't read the library: ${libErr.message}`, 500);
  if (!lib) return bad("Library not found", 404);

  // ── 1. The candidate rows ────────────────────────────────────────────────
  // A search never takes fewer than the default (the answer must not depend
  // on the caller's window — see the header).
  const limit = action === "search"
    ? Math.max(SEARCH_DEFAULT, Math.min(Number(body.limit) || SEARCH_DEFAULT, 100))
    : Math.max(1, Math.min(Number(body.limit) || 25, 100));
  type Read = { rows: StoredAnswerRow[]; error: string | null };
  const base = (columns: string) => supabaseAdmin.from("knowledge_questions").select(columns)
    .eq("org_id", orgId).eq("library_id", libraryId);
  const run = async (
    build: (columns: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
  ): Promise<Read> => {
    let res = await build(COLUMNS);
    if (missingColumn(res.error)) res = await build(CORE_COLUMNS);
    if (res.error) return { rows: [], error: res.error.message };
    return { rows: (res.data ?? []) as StoredAnswerRow[], error: null };
  };

  // ── 2. The reader's view ─────────────────────────────────────────────────
  /** Which of `rows` the reader may see (controllers: every row, DEC-43).
   *  Throws on any failed read — the caller fails closed. */
  const readerView = async (rows: StoredAnswerRow[]): Promise<{ visible: StoredAnswerRow[]; withheld: number }> => {
    if (principal.isController) return { visible: rows, withheld: 0 };
    // Earlier turns of the same conversations decide later ones. Read
    // oldest first; if a read comes back full, the turns after its last
    // row were not seen, so a listed turn later than that is withheld
    // (fail-safe) rather than judged on a partial conversation.
    const threadIds = [...new Set(rows.map((r) => r.thread_id).filter((t): t is string => isUuid(t)))];
    const threadRows: StoredAnswerRow[] = [];
    const unseenAfter = new Map<string, string>(); // thread → last created_at read
    const CONTEXT_PAGE = 1000;
    for (let i = 0; i < threadIds.length; i += 10) {
      const chunk = threadIds.slice(i, i + 10);
      const { data, error } = await supabaseAdmin.from("knowledge_questions").select(COLUMNS)
        .eq("org_id", orgId).eq("library_id", libraryId)
        .in("thread_id", chunk)
        .order("created_at", { ascending: true }).limit(CONTEXT_PAGE);
      if (error) throw new Error(error.message);
      const got = (data ?? []) as unknown as StoredAnswerRow[];
      threadRows.push(...got);
      if (got.length >= CONTEXT_PAGE) {
        const last = got[got.length - 1].created_at;
        for (const t of chunk) unseenAfter.set(t, last);
      }
    }
    const cited = [...rows, ...threadRows].flatMap((r) => citedKnowledgeDocIds(r.citations));
    const readable = await readableKnowledgeDocIds(principal, cited);
    const plan = planVisibleHistory(rows, threadRows, readable, user.id);
    const unchecked = (r: StoredAnswerRow) =>
      !!r.thread_id && unseenAfter.has(r.thread_id) && r.created_at > (unseenAfter.get(r.thread_id) as string);
    const visible = plan.visible.filter((r) => !unchecked(r));
    return { visible, withheld: plan.withheld.length + (plan.visible.length - visible.length) };
  };
  const accessFailed = (e: unknown) => bad(`Couldn't check access to the cited documents: ${(e as Error).message}`, 500);

  let visible: StoredAnswerRow[] = [];
  let withheld = 0;
  if (action === "list" || action === "thread") {
    let read: Read;
    if (action === "list") {
      read = await run((c) => base(c).order("created_at", { ascending: false }).limit(limit));
    } else {
      if (!isUuid(body.threadId)) return bad("threadId is required");
      const threadId = body.threadId;
      read = await run((c) => base(c).eq("thread_id", threadId).order("created_at", { ascending: true }).limit(200));
    }
    if (read.error) return bad(`Couldn't read the question history: ${read.error}`, 500);
    try { ({ visible, withheld } = await readerView(read.rows)); } catch (e) { return accessFailed(e); }
  } else {
    const q = String(body.query ?? "").trim();
    if (q.length >= 8) {
      // One page of matches, newest first. Full-text on search_tsv; before
      // that migration (no search_tsv), a plain ilike on the question.
      let fts = true;
      const page = async (from: number): Promise<Read> => {
        const to = from + SEARCH_PAGE - 1;
        if (fts) {
          const res = await base(COLUMNS)
            .textSearch("search_tsv", q, { type: "websearch", config: "english" })
            .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
          if (!res.error) return { rows: (res.data ?? []) as unknown as StoredAnswerRow[], error: null };
          if (from > 0) return { rows: [], error: res.error.message };
          fts = false;
        }
        return run((c) => base(c)
          .ilike("question", `%${q.slice(0, 60).replace(/[%_]/g, " ")}%`)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to));
      };
      // Page until `limit` rows the reader may see, or the matches run out,
      // or SEARCH_SCAN_CAP matches were looked at — never a window whose
      // size decides how many restricted matches can hide a visible one.
      const seen = new Set<string>();
      for (let from = 0; from < SEARCH_SCAN_CAP && visible.length < limit; from += SEARCH_PAGE) {
        const read = await page(from);
        if (read.error) return bad(`Couldn't read the question history: ${read.error}`, 500);
        const fresh = read.rows.filter((r) => !seen.has(r.id));
        for (const r of fresh) seen.add(r.id);
        try { visible.push(...(await readerView(fresh)).visible); } catch (e) { return accessFailed(e); }
        if (read.rows.length < SEARCH_PAGE) break;
      }
      visible = visible.slice(0, limit);
    }
  }

  return NextResponse.json({
    rows: visible.map((r) => ({
      id: r.id,
      libraryId: r.library_id,
      threadId: r.thread_id ?? null,
      question: r.question,
      answer: r.answer ?? null,
      citations: Array.isArray(r.citations) ? r.citations : [],
      userName: r.user_name ?? null,
      mode: r.mode === "internet" ? "internet" : "library",
      createdAt: r.created_at,
      // Continuing a conversation keeps its thread only when it is the
      // reader's own; a teammate's turns seed a NEW conversation.
      mine: !!r.user_id && r.user_id === user.id,
    })),
    // Never for a search: a count of withheld MATCHES is an oracle over the
    // text of answers the reader may not see.
    ...(action === "search" ? {} : { withheld }),
  });
}
