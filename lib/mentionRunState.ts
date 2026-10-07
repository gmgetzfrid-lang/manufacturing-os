// lib/mentionRunState.ts — the mention index's run state (IRLS-14; intelligence
// Round G I-23).
//
// One row per org in mention_index_runs
// (20261194_intel_roundG_mention_run_state.sql):
//
//   * the LAST BUILD — where it ran ('ingest': the pass that follows a
//     document reaching 'ready', lib/knowledgeIngest.ts
//     rebuildDocumentMentions; 'map': a rebuild pressed on the graph,
//     lib/mentionIndexer.ts backfillOrgMentions), when it started, and how
//     it ended ('running' until it reports; then 'succeeded', 'failed', or
//     'stopped' at its time limit). A build's end is written only while it
//     is still the last build — a later start owns the row's "last build";
//   * the LAST FAILED BUILD — where, when, which knowledge document, and its
//     error in plain words (plainBuildError; the raw text stays in the
//     server log, where the indexer logs it). It stands until the same
//     document's next build succeeds, or a rebuild from the map that began
//     after it reads the whole corpus. Either clears it only if it is still
//     the failure that build saw at its start (a compare on its time), so a
//     newer failure is never cleared by an older success;
//   * a STOPPED REBUILD — the last knowledge document (by id) it finished,
//     when the rebuild began, how many documents it has read — so the next
//     press continues after it instead of starting at the first document.
//
// The two builders write as the service role (the table has no write
// policy and no write grant for a signed-in session); a member reads their
// own org's row (RLS, 20261194). No client is imported here: the caller
// passes its own — the service role on the server, the browser's on the map.
//
// 20261194 may not be pasted yet. Every reader and writer here then behaves
// as the app did before the file: a missing table (PGRST205 / 42P01) or a
// missing column (42703 / PGRST204) records nothing and reads nothing
// (null), said once in the server log. Any other refusal is logged and
// never thrown — a build, an ingest batch and the map never fail for the
// record of a build.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDbError, type UserFacingKind } from "@/lib/userFacingError";

export const MENTION_RUNS_TABLE = "mention_index_runs";

/** Every column this code reads — the reader's SELECT and the start's
 *  RETURNING. 20261194 creates exactly these (its shape test pins it). */
export const MENTION_RUN_COLUMNS =
  "org_id, last_run_id, last_run_source, last_run_document_id, last_run_started_at, last_run_finished_at, last_run_outcome, "
  + "last_failed_at, last_failed_source, last_failed_document_id, last_failed_error, "
  + "backfill_cursor, backfill_started_at, backfill_documents";

export type MentionRunSource = "ingest" | "map";
export type MentionRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** A build that reports nothing for this long is taken to have been cut off
 *  (the ingest pass waits 8 s for its build and the map's rebuild route
 *  stops itself at 45 s of a 60 s limit; either can be killed by the
 *  platform before its end is written). */
export const BUILD_STALE_MS = 15 * 60_000;

/** The longest error sentence kept on the row. */
const ERROR_MAX = 500;

export interface MentionRunState {
  lastRun: {
    source: MentionRunSource;
    startedAt: string;
    finishedAt: string | null;
    outcome: MentionRunOutcome;
    documentId: string | null;
  } | null;
  lastFailure: {
    source: MentionRunSource;
    at: string;
    /** Plain words (plainBuildError). */
    error: string;
    documentId: string | null;
  } | null;
  /** A rebuild from the map that stopped before the end of the corpus. */
  backfill: { cursor: string; startedAt: string | null; documents: number } | null;
}

interface RunRow {
  org_id: string;
  last_run_id: string | null;
  last_run_source: string | null;
  last_run_document_id: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_run_outcome: string | null;
  last_failed_at: string | null;
  last_failed_source: string | null;
  last_failed_document_id: string | null;
  last_failed_error: string | null;
  backfill_cursor: string | null;
  backfill_started_at: string | null;
  backfill_documents: number | null;
}

type DbErr = { code?: string | null; message?: string | null } | null | undefined;

/** 20261194 is not pasted (or not all of it): the table is missing
 *  (PGRST205 / 42P01) or a column this code names is (42703 / PGRST204).
 *  Every reader and writer then does what the app did before the file. */
export function runStateMissing(error: DbErr): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "42P01" || code === "42703" || code === "PGRST204") return true;
  const msg = String(error.message ?? "");
  return new RegExp(`${MENTION_RUNS_TABLE}[\\s\\S]*(does not exist|schema cache)|(does not exist|schema cache)[\\s\\S]*${MENTION_RUNS_TABLE}`, "i").test(msg);
}

const sourceOf = (v: unknown): MentionRunSource | null => (v === "ingest" || v === "map" ? v : null);
const outcomeOf = (v: unknown): MentionRunOutcome | null =>
  (v === "running" || v === "succeeded" || v === "failed" || v === "stopped" ? v : null);

/** The row as the map and the builders read it. A part the row does not
 *  carry whole (no source, no time) is absent, never guessed. */
export function parseMentionRunRow(row: Partial<RunRow> | null | undefined): MentionRunState | null {
  if (!row) return null;
  const runSource = sourceOf(row.last_run_source);
  const outcome = outcomeOf(row.last_run_outcome);
  const failSource = sourceOf(row.last_failed_source);
  return {
    lastRun: runSource && outcome && row.last_run_started_at
      ? {
        source: runSource, startedAt: row.last_run_started_at, finishedAt: row.last_run_finished_at ?? null,
        outcome, documentId: row.last_run_document_id ?? null,
      }
      : null,
    lastFailure: failSource && row.last_failed_at
      ? {
        source: failSource, at: row.last_failed_at,
        error: String(row.last_failed_error ?? "").trim() || "The build failed and recorded no reason.",
        documentId: row.last_failed_document_id ?? null,
      }
      : null,
    backfill: row.backfill_cursor
      ? {
        cursor: row.backfill_cursor, startedAt: row.backfill_started_at ?? null,
        documents: Math.max(0, Math.floor(Number(row.backfill_documents ?? 0)) || 0),
      }
      : null,
  };
}

// ── plain words ───────────────────────────────────────────────────────────

/** The step a mention-index error names (lib/mentionIndexer.ts prefixes). */
const STEPS: Array<[RegExp, string]> = [
  [/^mention index write: /, "Writing the document's links to equipment"],
  [/^mention index cleanup: /, "Clearing the document's earlier links"],
  [/^mention index: /, "Reading the document's indexed text"],
];

/** Why, for every member who reads the map: never a table, column or
 *  policy name, and never "you" — nobody reading the map ran the build. */
const WHY: Partial<Record<UserFacingKind, string>> = {
  migration: "a part of the database it needs is missing (a migration has not been applied)",
  permission: "the database refused it (permission denied)",
  duplicate: "a link it wrote was already there",
  reference: "a document or a piece of equipment it links was removed while it ran",
  busy: "another change to the same records got in the way",
  conflict: "another change to the same records got in the way",
  timeout: "the database took too long to answer",
  unavailable: "the database could not be reached",
  network: "the database could not be reached",
  session: "the server's database session was refused",
};

/** A build's error in plain words: the step that failed and why. Every
 *  error a build meets is a driver's text (the indexer's own messages carry
 *  one after their step) or a program's (a module that did not load), never
 *  a sentence written for a reader — so anything this table does not know
 *  is said as unexpected, and its raw text stays in the server log. */
export function plainBuildError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: unknown })?.message ?? e ?? "")).trim();
  let step = "The build";
  let rest = raw;
  for (const [re, name] of STEPS) {
    if (re.test(raw)) { step = name; rest = raw.replace(re, ""); break; }
  }
  const code = typeof (e as { code?: unknown })?.code === "string" ? String((e as { code: string }).code) : null;
  const kind = classifyDbError({ message: rest, code });
  const why = WHY[kind]
    ?? (kind === "passthrough" ? "it stopped on an unexpected error" : "the database refused it unexpectedly");
  const text = `${step} failed: ${why}.`;
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

// ── the reader (the map, as the member) ───────────────────────────────────

/** The org's run state as this reader may see it (RLS: their own org's row).
 *  null when there is none, when 20261194 is not pasted (PGRST205 / 42P01 /
 *  42703 — the map then says what it said before the file), or when the read
 *  fails for any other reason (the map never claims a state it could not
 *  read). Never throws. */
export async function readMentionRunState(client: SupabaseClient, orgId: string): Promise<MentionRunState | null> {
  try {
    const { data, error } = await client.from(MENTION_RUNS_TABLE).select(MENTION_RUN_COLUMNS).eq("org_id", orgId).maybeSingle();
    if (error) return null;
    return parseMentionRunRow(data as Partial<RunRow> | null);
  } catch {
    return null;
  }
}

// ── the writers (the service role) ─────────────────────────────────────────

/** One build, as it was started. */
export interface MentionRunHandle {
  orgId: string;
  runId: string;
  source: MentionRunSource;
  documentId: string | null;
  startedAt: string;
  /** false: the start could not be recorded (20261194 not pasted, or the
   *  write refused) — every later write of this build is skipped, as before
   *  the file, except a failure where the table is there (`installed`). */
  recorded: boolean;
  /** false: 20261194 is not pasted (the start met PGRST205 / 42P01 / 42703 /
   *  PGRST204) — nothing at all is written for this build. */
  installed: boolean;
  /** The failure standing when this build started — the only one it may clear. */
  standingFailure: { documentId: string | null; at: string } | null;
  /** A stopped rebuild, as found when this build started. */
  backfill: { cursor: string; startedAt: string | null; documents: number } | null;
}

let missingSaid = false;
/** A run-state write that did not land: said in the server log, never thrown.
 *  A missing table or column (20261194 not pasted) is said once. */
function note(step: string, error: unknown): void {
  try {
    if (runStateMissing(error as DbErr)) {
      if (!missingSaid) {
        missingSaid = true;
        console.warn("[mentionRunState] mention_index_runs is not installed (20261194_intel_roundG_mention_run_state.sql) — mention builds are not recorded; everything else runs as before.");
      }
      return;
    }
    const msg = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    console.error("[mentionRunState]", `${step}: ${msg}`);
  } catch { /* logging never breaks a build */ }
}

const nowIso = () => new Date().toISOString();

/** Record a build's start. The returned handle carries what the row held at
 *  that moment (the standing failure, a stopped rebuild). Never throws. */
export async function startMentionRun(
  client: SupabaseClient, orgId: string, source: MentionRunSource, documentId: string | null = null,
): Promise<MentionRunHandle> {
  const startedAt = nowIso();
  const run: MentionRunHandle = {
    orgId, runId: crypto.randomUUID(), source, documentId, startedAt,
    recorded: false, installed: true, standingFailure: null, backfill: null,
  };
  try {
    // An upsert names only the last-build columns: the standing failure and a
    // stopped rebuild's cursor are left as they are.
    const { data, error } = await client.from(MENTION_RUNS_TABLE).upsert({
      org_id: orgId, last_run_id: run.runId, last_run_source: source, last_run_document_id: documentId,
      last_run_started_at: startedAt, last_run_finished_at: null, last_run_outcome: "running", updated_at: startedAt,
    }, { onConflict: "org_id" }).select(MENTION_RUN_COLUMNS);
    if (error) {
      run.installed = !runStateMissing(error);
      note("the build's start was not recorded", error);
      return run;
    }
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<Partial<RunRow>>;
    if (rows.length === 0) { note("the build's start was not recorded", { message: "no row came back" }); return run; }
    run.recorded = true;
    const state = parseMentionRunRow(rows[0]);
    run.standingFailure = state?.lastFailure ? { documentId: state.lastFailure.documentId, at: state.lastFailure.at } : null;
    run.backfill = state?.backfill ?? null;
  } catch (e) {
    note("the build's start was not recorded", e);
  }
  return run;
}

/** Record a build's end. 'failed' also records the failure (where, when,
 *  which document, plain words). Never throws. */
export async function finishMentionRun(
  client: SupabaseClient, run: MentionRunHandle,
  end: { outcome: "succeeded" | "stopped" | "failed"; error?: unknown; documentId?: string | null },
): Promise<void> {
  const at = nowIso();
  if (!run.recorded) {
    // The start did not land (a refusal, not a missing table): the failure
    // is still worth one attempt — it is what the map names.
    if (end.outcome === "failed" && run.installed) {
      await recordMentionFailure(client, run.orgId, run.source, end.documentId ?? run.documentId, end.error, at);
    }
    return;
  }
  try {
    // Only while it is still the last build: a build that started after this
    // one owns the row's "last build", so no row matching is that, not a
    // refusal. A failure is recorded below either way.
    const { error } = await client.from(MENTION_RUNS_TABLE)
      .update({ last_run_finished_at: at, last_run_outcome: end.outcome, updated_at: at })
      .eq("org_id", run.orgId).eq("last_run_id", run.runId).select("org_id");
    if (error) note("the build's end was not recorded", error);
  } catch (e) {
    note("the build's end was not recorded", e);
  }
  if (end.outcome === "failed") await recordMentionFailure(client, run.orgId, run.source, end.documentId ?? run.documentId, end.error, at);
}

/** Record a failed build (the newest failure replaces the one standing).
 *  Used by finishMentionRun, and directly for a build that failed before it
 *  could be started. Never throws. */
export async function recordMentionFailure(
  client: SupabaseClient, orgId: string, source: MentionRunSource, documentId: string | null, error: unknown, at = nowIso(),
): Promise<boolean> {
  // The indexer logs its own failures where they happen (WIRE-2); anything
  // else (a listing that failed, an engine that did not load) is logged here,
  // raw, since the row keeps only the plain words.
  try {
    const raw = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    if (!/^mention index(?: write| cleanup)?: /.test(raw)) console.error("[mentionRunState] a mention build failed:", raw, { orgId, documentId });
  } catch { /* logging never breaks a build */ }
  try {
    const { data, error: e } = await client.from(MENTION_RUNS_TABLE).upsert({
      org_id: orgId, last_failed_at: at, last_failed_source: source, last_failed_document_id: documentId,
      last_failed_error: plainBuildError(error), updated_at: at,
    }, { onConflict: "org_id" }).select("org_id");
    if (e) { note("the build's failure was not recorded", e); return false; }
    if ((data ?? []).length === 0) { note("the build's failure was not recorded", { message: "no row came back" }); return false; }
    return true;
  } catch (x) {
    note("the build's failure was not recorded", x);
    return false;
  }
}

/** Clear the failure that stood when this build started — only if it still
 *  stands (a compare on its time): a newer failure is never cleared. The
 *  caller decides that this build supersedes it. Never throws. */
export async function clearStandingFailure(client: SupabaseClient, run: MentionRunHandle): Promise<boolean> {
  const f = run.standingFailure;
  if (!run.recorded || !f) return false;
  run.standingFailure = null;
  try {
    const at = nowIso();
    const { data, error } = await client.from(MENTION_RUNS_TABLE)
      .update({ last_failed_at: null, last_failed_source: null, last_failed_document_id: null, last_failed_error: null, updated_at: at })
      .eq("org_id", run.orgId).eq("last_failed_at", f.at).select("org_id");
    if (error) { note("the superseded failure was not cleared", error); return false; }
    return (data ?? []).length > 0; // 0: a newer failure was recorded since — it stands
  } catch (e) {
    note("the superseded failure was not cleared", e);
    return false;
  }
}

/** Save where a rebuild from the map is: the last document it finished, when
 *  the rebuild began, how many documents it has read. Never throws. */
export async function saveBackfillCursor(
  client: SupabaseClient, run: MentionRunHandle, at: { cursor: string; startedAt: string; documents: number },
): Promise<boolean> {
  if (!run.recorded) return false;
  try {
    const { data, error } = await client.from(MENTION_RUNS_TABLE)
      .update({ backfill_cursor: at.cursor, backfill_started_at: at.startedAt, backfill_documents: at.documents, updated_at: nowIso() })
      .eq("org_id", run.orgId).select("org_id");
    if (error) { note("the rebuild's place was not saved", error); return false; }
    return (data ?? []).length > 0;
  } catch (e) {
    note("the rebuild's place was not saved", e);
    return false;
  }
}

/** A rebuild from the map read the whole corpus: nothing is left to continue. */
export async function clearBackfillCursor(client: SupabaseClient, run: MentionRunHandle): Promise<boolean> {
  if (!run.recorded) return false;
  try {
    const { data, error } = await client.from(MENTION_RUNS_TABLE)
      .update({ backfill_cursor: null, backfill_started_at: null, backfill_documents: 0, updated_at: nowIso() })
      .eq("org_id", run.orgId).select("org_id");
    if (error) { note("the finished rebuild's place was not cleared", error); return false; }
    return (data ?? []).length > 0;
  } catch (e) {
    note("the finished rebuild's place was not cleared", e);
    return false;
  }
}
