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
// conversation. Controllers read all memory (DEC-43).
//
// Fails CLOSED: any read or ACL error answers an error and no rows — never an
// unfiltered answer.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import {
  citedKnowledgeDocIds, isUuid, planVisibleHistory, readableKnowledgeDocIds, type StoredAnswerRow,
} from "@/lib/knowledgeHistory";

export const runtime = "nodejs";

const COLUMNS = "id, org_id, library_id, thread_id, user_id, user_name, question, answer, citations, mode, created_at";

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
  const limit = Math.max(1, Math.min(Number(body.limit) || (action === "search" ? 5 : 25), 100));
  type Read = { rows: StoredAnswerRow[]; error: string | null };
  const base = (columns: string) => supabaseAdmin.from("knowledge_questions").select(columns)
    .eq("org_id", orgId).eq("library_id", libraryId);
  const run = async (
    build: (columns: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
  ): Promise<Read> => {
    let res = await build(COLUMNS);
    if (missingColumn(res.error)) res = await build("id, org_id, library_id, user_id, user_name, question, answer, citations, created_at");
    if (res.error) return { rows: [], error: res.error.message };
    return { rows: (res.data ?? []) as StoredAnswerRow[], error: null };
  };

  let read: Read = { rows: [], error: null };
  if (action === "list") {
    read = await run((c) => base(c).order("created_at", { ascending: false }).limit(limit));
  } else if (action === "thread") {
    if (!isUuid(body.threadId)) return bad("threadId is required");
    const threadId = body.threadId;
    read = await run((c) => base(c).eq("thread_id", threadId).order("created_at", { ascending: true }).limit(200));
  } else {
    const q = String(body.query ?? "").trim();
    if (q.length >= 8) {
      // Filtering happens after the match, so read with headroom and trim
      // to the limit once the reader's view is known.
      const fetchN = Math.min(limit * 4, 100);
      const fts = await base(COLUMNS)
        .textSearch("search_tsv", q, { type: "websearch", config: "english" })
        .order("created_at", { ascending: false }).limit(fetchN);
      if (!fts.error) read = { rows: (fts.data ?? []) as unknown as StoredAnswerRow[], error: null };
      else {
        // Pre-migration (no search_tsv): a plain ilike on the question.
        read = await run((c) => base(c)
          .ilike("question", `%${q.slice(0, 60).replace(/[%_]/g, " ")}%`)
          .order("created_at", { ascending: false }).limit(fetchN));
      }
    }
  }
  if (read.error) return bad(`Couldn't read the question history: ${read.error}`, 500);
  const rows = read.rows;

  // ── 2. The reader's view ─────────────────────────────────────────────────
  let visible = rows;
  let withheld = 0;
  if (!principal.isController) {
    try {
      // Earlier turns of the same conversations decide later ones.
      const threadIds = [...new Set(rows.map((r) => r.thread_id).filter((t): t is string => isUuid(t)))];
      const threadRows: StoredAnswerRow[] = [];
      for (let i = 0; i < threadIds.length; i += 50) {
        const { data, error } = await supabaseAdmin.from("knowledge_questions").select(COLUMNS)
          .eq("org_id", orgId).eq("library_id", libraryId)
          .in("thread_id", threadIds.slice(i, i + 50))
          .order("created_at", { ascending: true }).limit(1000);
        if (error) throw new Error(error.message);
        threadRows.push(...((data ?? []) as unknown as StoredAnswerRow[]));
      }
      const cited = [...rows, ...threadRows].flatMap((r) => citedKnowledgeDocIds(r.citations));
      const readable = await readableKnowledgeDocIds(principal, cited);
      const plan = planVisibleHistory(rows, threadRows, readable);
      visible = plan.visible;
      withheld = plan.withheld.length;
    } catch (e) {
      return bad(`Couldn't check access to the cited documents: ${(e as Error).message}`, 500);
    }
  }
  if (action === "search") visible = visible.slice(0, limit);

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
    withheld,
  });
}
