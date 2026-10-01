// lib/knowledgeHistory.ts — SERVER-ONLY. Who may read a stored answer.
//
// The ask route answers every question under the ASKER's own ACL: two people
// asking the same thing correctly get different answers (lib/knowledgeAccess).
// The finished answer — its text, its verbatim quotes, the documents it cites
// — is then stored in knowledge_questions. Replaying that row to someone else
// replays what the asker's ACL admitted, so every replay is re-decided here,
// for the CURRENT reader, through the same seam retrieval uses
// (loadPrincipal + readableControlledDocIds — never a parallel evaluator).
//
// The rule, fail-safe for what a row records: an answer is as restricted as
// its most restricted SOURCE. A row is shown only when every document it
// cites — and, on a row the ask route wrote with its context (20261153,
// intelligence Round G I-03), every knowledge document whose passages, legend
// text, page images or drawing facts reached the model — resolves, now, to a
// document the reader may read. A row whose context could not be recorded in
// full (more documents than ANSWER_CONTEXT_DOC_CAP) or whose conversation
// history came from the client unverified (ASK-5) proves nothing about its
// sources and is its asker's alone. A row written before 20261153 carries no
// context and is judged by what it cites, as before:
//   - an upload-origin knowledge document of the reader's org — readable (the
//     same content as the PDF every member can open, by design);
//   - a mirror of a controlled document — readable when
//     readableControlledDocIds admits its controlled document;
//   - anything else (a knowledge document since deleted or held back from the
//     AI, another org's id, a malformed id) — NOT readable: nothing proves it.
// A library answer that cites NO document proves nothing about its sources:
// the model may have answered from retrieved passages without a [n] marker
// (or with invented markers the ask route stripped), and a "Nothing matches"
// row names the asker's own indexing gaps. The row records only what it
// cites, so such a row is shown to its asker alone (and to controllers). An
// internet-mode answer (web sources only) is shown to everyone.
// A conversation carries its earlier turns into every later answer (the ask
// sends them back as context), so once a turn is withheld every later turn
// of the same thread is withheld too. A conversation continued from someone
// else's record starts a NEW thread, which records nothing of the turns it
// was seeded with — so the page never sends those back (askContextHistory,
// lib/knowledge.ts).
//
// DEC-43: controllers read all memory — the caller skips the filter for them,
// exactly as knowledge_questions_select (20261120) lets them read every row.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readableControlledDocIds, type KnowledgePrincipal } from "@/lib/knowledgeAccess";

export interface StoredAnswerRow {
  id: string;
  org_id?: string | null;
  library_id: string;
  thread_id?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  question: string;
  answer?: string | null;
  citations?: unknown;
  mode?: string | null;
  created_at: string;
  /** knowledge_questions.context (20261153) — what reached the model. */
  context?: unknown;
}

/** The most knowledge documents one row's context records. A larger set is
 *  recorded as incomplete, which keeps the row its asker's alone. */
export const ANSWER_CONTEXT_DOC_CAP = 2000;

/** knowledge_questions.context, as the ask route writes it (ASK-1 / KACL-1 /
 *  IEDGE-5, ASK-3, ASK-5, PR-9, IRLS-13; migration 20261153). */
export interface AnswerContext {
  v: 1;
  /** Every knowledge document whose passages, legend text, page images or
   *  drawing facts reached the model for this answer. */
  documents: string[];
  /** False when there were more than ANSWER_CONTEXT_DOC_CAP of them. */
  complete: boolean;
  /** Where the conversation context came from: the record of the asker's own
   *  thread, unverified client input, or none. */
  history: "none" | "thread" | "client";
  /** ASK-3: the answer stopped at the model's length limit. */
  partial?: boolean;
  /** PR-9: the answer carries arithmetic nothing re-derived. */
  arithmetic?: "unverified";
  /** IRLS-13: the Reasoning Skills that rode the prompt. */
  skills?: string[];
}

/** Read a stored context; null for a row written before 20261153 (or a value
 *  that is not one) — such a row is judged by its citations alone. */
export function parseAnswerContext(raw: unknown): AnswerContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.documents)) return null;
  return {
    v: 1,
    documents: c.documents.filter((d): d is string => typeof d === "string" && d.length > 0),
    complete: c.complete === true,
    history: c.history === "thread" || c.history === "client" ? c.history : "none",
    ...(c.partial === true ? { partial: true } : {}),
    ...(c.arithmetic === "unverified" ? { arithmetic: "unverified" as const } : {}),
    ...(Array.isArray(c.skills) ? { skills: c.skills.filter((x): x is string => typeof x === "string") } : {}),
  };
}

/** The knowledge documents a stored row's context says reached the model. */
export function contextKnowledgeDocIds(raw: unknown): string[] {
  return parseAnswerContext(raw)?.documents ?? [];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** The knowledge-document ids a stored answer cites. Web citations (url,
 *  title) name no document and contribute nothing. A citation whose id is
 *  present but not a uuid is returned as-is so it resolves to nothing — and
 *  therefore withholds the row — rather than being silently skipped. */
export function citedKnowledgeDocIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const out = new Set<string>();
  for (const c of citations) {
    if (!c || typeof c !== "object") continue;
    const id = (c as { documentId?: unknown }).documentId;
    if (id === undefined || id === null || id === "") continue;
    out.add(String(id));
  }
  return [...out];
}

const byTime = (a: StoredAnswerRow, b: StoredAnswerRow) =>
  a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at);

/**
 * Pure: which of `rows` may a reader see, given the knowledge documents they
 * may read? `threadRows` are the other turns of the same conversations (any
 * order; duplicates of `rows` are fine) — a turn after a withheld turn is
 * withheld, because the earlier answer rode along as its context.
 * `readerUid` is the reader: a library answer citing no document is shown to
 * its asker only (null = nobody's own — every such row is withheld).
 */
export function planVisibleHistory(
  rows: readonly StoredAnswerRow[],
  threadRows: readonly StoredAnswerRow[],
  readable: ReadonlySet<string>,
  readerUid: string | null,
): { visible: StoredAnswerRow[]; withheld: StoredAnswerRow[] } {
  const citesUnreadable = (r: StoredAnswerRow) => {
    const cited = citedKnowledgeDocIds(r.citations);
    if (cited.some((id) => !readable.has(id))) return true;
    const ownRow = !!readerUid && r.user_id === readerUid;
    // What reached the model, recorded since 20261153: every one must be
    // readable too, and a context that is incomplete or rests on unverified
    // client history proves nothing, so only its asker sees the row.
    const ctx = parseAnswerContext(r.context);
    if (ctx) {
      if (ctx.documents.some((id) => !readable.has(id))) return true;
      if ((!ctx.complete || ctx.history === "client") && !ownRow) return true;
    }
    // Nothing cited: a web answer is safe; a library answer proves nothing
    // about the passages it was built from, so only its asker sees it.
    if (cited.length === 0 && r.mode !== "internet") return !ownRow;
    return false;
  };

  const tainted = new Set<string>();
  const threads = new Map<string, StoredAnswerRow[]>();
  for (const r of [...threadRows, ...rows]) {
    if (!r.thread_id) continue;
    const list = threads.get(r.thread_id) ?? [];
    if (!list.some((x) => x.id === r.id)) list.push(r);
    threads.set(r.thread_id, list);
  }
  for (const turns of threads.values()) {
    let poisoned = false;
    for (const t of [...turns].sort(byTime)) {
      if (poisoned || citesUnreadable(t)) { poisoned = true; tainted.add(t.id); }
    }
  }

  const visible: StoredAnswerRow[] = [];
  const withheld: StoredAnswerRow[] = [];
  for (const r of rows) {
    const hide = r.thread_id ? tainted.has(r.id) : citesUnreadable(r);
    (hide ? withheld : visible).push(r);
  }
  return { visible, withheld };
}

/**
 * Which of these knowledge-document ids may the principal read now? Throws on
 * a failed read of knowledge_documents — the caller fails CLOSED (serves
 * nothing) rather than serving an unfiltered answer. A failed read of the
 * controlled documents themselves admits none of them (closed).
 * loadDcLandscape (lib/knowledgeAccess, the seam owner's file) ignores a
 * failed libraries / folders read and would then judge a document restricted
 * ONLY by its library or folder ACL by its own ACL alone; until it throws,
 * the same two reads are made here first and a failure of either throws
 * (closed). What remains is a read failing between this check and the
 * seam's own — closed for good when loadDcLandscape throws (handed over).
 * loadPrincipal (same file) ignores a failed team_members read too, leaving
 * teamIds empty, so an ACL that DENIES the reader's team would never match
 * and the document would be judged readable. The reader's teams are read
 * again here, a failure throws (closed), and the mirrors are judged with the
 * teams actually read — until loadPrincipal throws on that read (handed over).
 */
export async function readableKnowledgeDocIds(
  principal: KnowledgePrincipal,
  kdocIds: readonly string[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  const ids = [...new Set(kdocIds)].filter(isUuid);
  if (ids.length === 0) return readable;

  const rows: Array<{ id: string; org_id: string; source_document_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_documents")
      .select("id, org_id, source_document_id")
      .in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`knowledge documents unreadable: ${error.message}`);
    rows.push(...((data ?? []) as typeof rows));
  }

  const mirrors = new Map<string, string>(); // knowledge doc id → controlled doc id
  for (const r of rows) {
    if (r.org_id !== principal.orgId) continue;          // another org's document: never
    if (!r.source_document_id) readable.add(r.id);        // upload-origin: org-readable by design
    else mirrors.set(r.id, r.source_document_id);
  }
  if (mirrors.size > 0) {
    let reader = principal;
    if (!principal.isController) {
      await assertDcLandscapeReadable(principal.orgId);
      reader = { ...principal, teamIds: await readerTeamIds(principal.uid) };
    }
    const ok = await readableControlledDocIds(reader, [...new Set(mirrors.values())]);
    for (const [kid, dcId] of mirrors) if (ok.has(dcId)) readable.add(kid);
  }
  return readable;
}

/** The two reads loadDcLandscape depends on and does not check: the org's
 *  document libraries and folders. A failure of either throws, so the caller
 *  answers nothing rather than judging a document without its library or
 *  folder ACL. */
async function assertDcLandscapeReadable(orgId: string): Promise<void> {
  const reads = [
    { table: "libraries", what: "document libraries" },
    { table: "collections", what: "folders" },
  ] as const;
  for (const { table, what } of reads) {
    const { error } = await supabaseAdmin.from(table).select("id", { count: "exact", head: true }).eq("org_id", orgId);
    if (error) throw new Error(`the ${what} (and their access rules) could not be read: ${error.message}`);
  }
}

/** The reader's teams, read so that a failure is an error: loadPrincipal's
 *  own read of team_members ignores one (teamIds [] — a team DENY never
 *  matches), which would judge a document denied to the reader's team as
 *  readable. The caller answers nothing rather than judge without them. */
async function readerTeamIds(uid: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("team_members").select("team_id").eq("uid", uid);
  if (error) throw new Error(`your teams (and the access rules that name them) could not be read: ${error.message}`);
  return ((data ?? []) as Array<{ team_id: string }>).map((t) => t.team_id);
}
