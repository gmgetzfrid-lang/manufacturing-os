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
//   * a REBUILD'S PLACE — written by a rebuild from the map from its start
//     to its end: its state ('running' while a press reads, saved every few
//     seconds; 'time_limit' or 'failed' when the press stopped), the last
//     knowledge document (by id) it finished, when the rebuild began, how
//     many documents it has read, when the place was saved, and a
//     fingerprint of the equipment dictionary it reads with. The next press
//     continues after it only when the dictionary is the same and the
//     rebuild began less than BACKFILL_RESUME_MAX_MS ago; otherwise it starts
//     at the first document and overwrites the place. A rebuild that reads
//     to the end clears it.
//
// The two builders write as the service role (the table has no write
// policy and no write grant for a signed-in session); a member reads their
// own org's row, and only its MENTION_RUN_MEMBER_COLUMNS (RLS and a
// column-level grant, 20261194): never a knowledge-document id, the
// rebuild's cursor or the fingerprint. No client is imported here: the
// caller passes its own — the service role on the server, the browser's on
// the map. Every UPDATE goes through checkedWrite (SAF-18's census judges
// this file); a zero-row match is answered as `false` where it is expected.
//
// 20261194 may not be pasted yet. Every reader and writer here then behaves
// as the app did before the file: a missing table (PGRST205 / 42P01) or a
// missing column (42703 / PGRST204) records nothing and reads nothing
// (null), said once in the server log. Any other refusal is logged and
// never thrown — a build, an ingest batch and the map never fail for the
// record of a build.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDbError, type UserFacingKind } from "@/lib/userFacingError";
import { checkedWrite, type CheckedWriteFailure } from "@/lib/checkedWrite";

export const MENTION_RUNS_TABLE = "mention_index_runs";

/** Every column the builders read back (the start's RETURNING). 20261194
 *  creates exactly these, plus updated_at (its shape test pins it). */
export const MENTION_RUN_COLUMNS =
  "org_id, last_run_id, last_run_source, last_run_document_id, last_run_started_at, last_run_finished_at, last_run_outcome, "
  + "last_failed_at, last_failed_source, last_failed_document_id, last_failed_error, "
  + "backfill_cursor, backfill_started_at, backfill_documents, backfill_state, backfill_saved_at, backfill_dictionary";

/** The columns a signed-in member may read — 20261194 grants SELECT on these
 *  and no other (the map reads them). Never a knowledge-document id (a
 *  mirror's id may name a document the member cannot open), the rebuild's
 *  cursor (an id too) or the dictionary's fingerprint. */
export const MENTION_RUN_MEMBER_COLUMNS =
  "org_id, last_run_source, last_run_started_at, last_run_finished_at, last_run_outcome, "
  + "last_failed_at, last_failed_source, last_failed_error, "
  + "backfill_started_at, backfill_documents, backfill_state, backfill_saved_at";

export type MentionRunSource = "ingest" | "map";
export type MentionRunOutcome = "running" | "succeeded" | "failed" | "stopped";
/** A rebuild's place: a press is reading ('running'), or the last press
 *  stopped at its time limit or on a failure. */
export type BackfillState = "running" | "time_limit" | "failed";

/** A build that reports nothing for this long is taken to have been cut off
 *  (the ingest pass waits 8 s for its build and the map's rebuild route
 *  stops itself at 45 s of a 60 s limit; either can be killed by the
 *  platform before its end is written). */
export const BUILD_STALE_MS = 15 * 60_000;

/** A rebuild's place saved as 'running' within this long is a press that may
 *  still be reading: the press saves it every 10 s while it reads, and the
 *  route that runs it is killed at 60 s (app/api/graph/mentions/route.ts
 *  maxDuration). Older, that press was cut off. */
export const REBUILD_ALIVE_MS = 2 * 60_000;

/** A stopped rebuild that began longer ago than this is not continued: the
 *  next press starts at the first document (and the map says so). */
export const BACKFILL_RESUME_MAX_MS = 24 * 60 * 60_000;

/** The longest error sentence kept on the row. */
const ERROR_MAX = 500;

export interface BackfillPlace {
  /** The last knowledge document (by id) the rebuild finished. The server's
   *  only: a member's read never carries it (null there). */
  cursor: string | null;
  /** When the rebuild began (its first press). */
  startedAt: string | null;
  /** Documents the rebuild has read so far, across its presses. */
  documents: number;
  state: BackfillState | null;
  /** When the place was last saved. */
  savedAt: string | null;
  /** The fingerprint of the equipment dictionary it reads with. The
   *  server's only (null in a member's read). */
  dictionary: string | null;
}

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
  /** A rebuild from the map that has not read to the end: one reading now,
   *  or one that stopped. */
  backfill: BackfillPlace | null;
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
  backfill_state: string | null;
  backfill_saved_at: string | null;
  backfill_dictionary: string | null;
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
const placeStateOf = (v: unknown): BackfillState | null =>
  (v === "running" || v === "time_limit" || v === "failed" ? v : null);

/** The row as the map and the builders read it. A part the row does not
 *  carry whole (no source, no time) is absent, never guessed. A member's
 *  read carries no cursor and no fingerprint: those parts are null. */
export function parseMentionRunRow(row: Partial<RunRow> | null | undefined): MentionRunState | null {
  if (!row) return null;
  const runSource = sourceOf(row.last_run_source);
  const outcome = outcomeOf(row.last_run_outcome);
  const failSource = sourceOf(row.last_failed_source);
  const placeState = placeStateOf(row.backfill_state);
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
    backfill: placeState || row.backfill_cursor
      ? {
        cursor: row.backfill_cursor ?? null, startedAt: row.backfill_started_at ?? null,
        documents: Math.max(0, Math.floor(Number(row.backfill_documents ?? 0)) || 0),
        state: placeState, savedAt: row.backfill_saved_at ?? null, dictionary: row.backfill_dictionary ?? null,
      }
      : null,
  };
}

/** How a rebuild's place reads at `now` — the map's sentence about it:
 *   * running  — a press saved it as reading within REBUILD_ALIVE_MS;
 *   * none     — it holds no document read (nothing to continue);
 *   * expired  — the rebuild began more than BACKFILL_RESUME_MAX_MS ago (or
 *                when is not known): the next press starts over;
 *   * continue — the next press continues after it, by why the last press
 *                ended: its time limit, a failure, or cut off (saved as
 *                reading, then never again).
 *  The next press also starts over when the equipment dictionary changed
 *  since — the server's check (backfillOrgMentions); a member's read
 *  cannot see the fingerprint, so the press's answer says when it did. */
export type BackfillReading =
  | { kind: "running" }
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "continue"; why: "time_limit" | "failed" | "cut_off" };

export function readBackfillPlace(place: BackfillPlace | null | undefined, now: number): BackfillReading | null {
  if (!place) return null;
  const saved = Date.parse(place.savedAt ?? "");
  if (place.state === "running" && Number.isFinite(saved) && now - saved <= REBUILD_ALIVE_MS) return { kind: "running" };
  if (place.documents <= 0) return { kind: "none" };
  const began = Date.parse(place.startedAt ?? "");
  if (!Number.isFinite(began) || now - began > BACKFILL_RESUME_MAX_MS) return { kind: "expired" };
  return { kind: "continue", why: place.state === "time_limit" || place.state === "failed" ? place.state : "cut_off" };
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

/** The org's run state as this reader may see it (RLS: their own org's row;
 *  the column grant: MENTION_RUN_MEMBER_COLUMNS only). null when there is
 *  none, when 20261194 is not pasted (PGRST205 / 42P01 / 42703 — the map
 *  then says what it said before the file), or when the read fails for any
 *  other reason (the map never claims a state it could not read). Never
 *  throws. */
export async function readMentionRunState(supabase: SupabaseClient, orgId: string): Promise<MentionRunState | null> {
  try {
    const { data, error } = await supabase.from(MENTION_RUNS_TABLE).select(MENTION_RUN_MEMBER_COLUMNS).eq("org_id", orgId).maybeSingle();
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
  /** A rebuild's place, as found when this build started. */
  backfill: BackfillPlace | null;
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

/** A checked UPDATE that met a database error: logged with its code (a
 *  missing table said once). A zero-row match ('refused') is the caller's
 *  to answer — each says why it may happen. */
function noteWrite(step: string, w: CheckedWriteFailure): void {
  if (w.code !== "db") return;
  note(step, { code: w.pgCode ?? null, message: w.pgCode ? `${w.error} (${w.pgCode})` : w.error });
}

const nowIso = () => new Date().toISOString();

/** Record a build's start. The returned handle carries what the row held at
 *  that moment (the standing failure, a rebuild's place). Never throws. */
export async function startMentionRun(
  supabase: SupabaseClient, orgId: string, source: MentionRunSource, documentId: string | null = null,
): Promise<MentionRunHandle> {
  const startedAt = nowIso();
  const run: MentionRunHandle = {
    orgId, runId: crypto.randomUUID(), source, documentId, startedAt,
    recorded: false, installed: true, standingFailure: null, backfill: null,
  };
  try {
    // An upsert names only the last-build columns: the standing failure and a
    // rebuild's place are left as they are, and come back in its RETURNING.
    const { data, error } = await supabase.from(MENTION_RUNS_TABLE).upsert({
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
 *  which document, plain words). Answers whether the END landed: false when
 *  the start was not recorded, when the write failed (logged), and —
 *  DELIBERATELY, not a refusal — when the update matched no row because a
 *  build that started after this one owns the row's "last build" (its run
 *  id replaced this one's); that later build's end is the one the map
 *  reads. A failure is recorded either way. Never throws. */
export async function finishMentionRun(
  supabase: SupabaseClient, run: MentionRunHandle,
  end: { outcome: "succeeded" | "stopped" | "failed"; error?: unknown; documentId?: string | null },
): Promise<boolean> {
  const at = nowIso();
  if (!run.recorded) {
    // The start did not land (a refusal, not a missing table): the failure
    // is still worth one attempt — it is what the map names.
    if (end.outcome === "failed" && run.installed) {
      await recordMentionFailure(supabase, run.orgId, run.source, end.documentId ?? run.documentId, end.error, at);
    }
    return false;
  }
  let landed = false;
  try {
    const w = await checkedWrite(supabase.from(MENTION_RUNS_TABLE)
      .update({ last_run_finished_at: at, last_run_outcome: end.outcome, updated_at: at })
      .eq("org_id", run.orgId).eq("last_run_id", run.runId).select("org_id"));
    landed = w.ok;
    // w.code 'refused' (zero rows): superseded by a later build — expected, not logged.
    if (!w.ok) noteWrite("the build's end was not recorded", w);
  } catch (e) {
    note("the build's end was not recorded", e);
  }
  if (end.outcome === "failed") await recordMentionFailure(supabase, run.orgId, run.source, end.documentId ?? run.documentId, end.error, at);
  return landed;
}

/** Record a failed build (the newest failure replaces the one standing).
 *  Used by finishMentionRun, and directly for a build that failed before it
 *  could be started. Never throws. */
export async function recordMentionFailure(
  supabase: SupabaseClient, orgId: string, source: MentionRunSource, documentId: string | null, error: unknown, at = nowIso(),
): Promise<boolean> {
  // The indexer logs its own failures where they happen (WIRE-2); anything
  // else (a listing that failed, an engine that did not load) is logged here,
  // raw, since the row keeps only the plain words.
  try {
    const raw = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    if (!/^mention index(?: write| cleanup)?: /.test(raw)) console.error("[mentionRunState] a mention build failed:", raw, { orgId, documentId });
  } catch { /* logging never breaks a build */ }
  try {
    const { data, error: e } = await supabase.from(MENTION_RUNS_TABLE).upsert({
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
 *  caller decides that this build supersedes it. Answers false, not logged,
 *  when the update matched no row: a newer failure was recorded since, and
 *  it stands. Never throws. */
export async function clearStandingFailure(supabase: SupabaseClient, run: MentionRunHandle): Promise<boolean> {
  const f = run.standingFailure;
  if (!run.recorded || !f) return false;
  run.standingFailure = null;
  try {
    const at = nowIso();
    const w = await checkedWrite(supabase.from(MENTION_RUNS_TABLE)
      .update({ last_failed_at: null, last_failed_source: null, last_failed_document_id: null, last_failed_error: null, updated_at: at })
      .eq("org_id", run.orgId).eq("last_failed_at", f.at).select("org_id"));
    if (!w.ok) noteWrite("the superseded failure was not cleared", w);
    return w.ok;
  } catch (e) {
    note("the superseded failure was not cleared", e);
    return false;
  }
}

/** Save a rebuild's place: its state, the last document it finished (none
 *  yet: null), when the rebuild began, how many documents it has read and
 *  the dictionary's fingerprint — stamped with when it was saved. The whole
 *  place is written each time, so the last writer's is whole. Answers false
 *  when it did not land (zero rows: the org's row is gone). Never throws. */
export async function saveBackfillCursor(
  supabase: SupabaseClient, run: MentionRunHandle,
  place: { cursor: string | null; startedAt: string; documents: number; state: BackfillState; dictionary: string },
): Promise<boolean> {
  if (!run.recorded) return false;
  try {
    const at = nowIso();
    const w = await checkedWrite(supabase.from(MENTION_RUNS_TABLE)
      .update({
        backfill_cursor: place.cursor, backfill_started_at: place.startedAt, backfill_documents: place.documents,
        backfill_state: place.state, backfill_saved_at: at, backfill_dictionary: place.dictionary, updated_at: at,
      })
      .eq("org_id", run.orgId).select("org_id"));
    if (!w.ok) noteWrite("the rebuild's place was not saved", w);
    return w.ok;
  } catch (e) {
    note("the rebuild's place was not saved", e);
    return false;
  }
}

/** A rebuild from the map read the whole corpus: nothing is left to continue. */
export async function clearBackfillCursor(supabase: SupabaseClient, run: MentionRunHandle): Promise<boolean> {
  if (!run.recorded) return false;
  try {
    const w = await checkedWrite(supabase.from(MENTION_RUNS_TABLE)
      .update({
        backfill_cursor: null, backfill_started_at: null, backfill_documents: 0,
        backfill_state: null, backfill_saved_at: null, backfill_dictionary: null, updated_at: nowIso(),
      })
      .eq("org_id", run.orgId).select("org_id"));
    if (!w.ok) noteWrite("the finished rebuild's place was not cleared", w);
    return w.ok;
  } catch (e) {
    note("the finished rebuild's place was not cleared", e);
    return false;
  }
}
