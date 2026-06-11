// lib/checkoutEpisodes.ts
//
// CHECKOUT EPISODES — the checkout "ticket".
//
// The mental model this module enforces:
//
//   * The FIRST checkout on an idle document OPENS an episode (Checkout #N).
//   * Anyone who checks out while the episode is live JOINS that episode —
//     same thread, same record.
//   * The episode CLOSES only when the LAST active session ends. If the lock
//     holder checks in while collaborators remain, the lock TRANSFERS to the
//     longest-running remaining session — the document never reads "free"
//     while someone still has it out.
//   * A closed episode is a sealed history record (participants, who/why,
//     chat log, revisions published in its window). The next checkout opens
//     a FRESH episode with an empty thread.
//
// Every state transition for the checkout system lives here — the modal,
// the status cell, the stale banner, the admin force-release, the project
// bulk release, and the cron sweep all call into this module so the rules
// can't drift between surfaces.
//
// The decision logic is pure (computeCheckInTransition & friends) so it is
// unit-tested without a database, same pattern as ticketTransitions and
// documentGuards.
//
// Pre-migration tolerance: if the 20260729 migration hasn't been applied yet
// (no checkout_episodes table / episode_id columns), every helper degrades to
// the legacy document-scoped behavior instead of breaking checkout.

import { supabase } from "@/lib/supabase";

type SupabaseLike = typeof supabase;

// ─── Types ───────────────────────────────────────────────────────────────

export interface CheckoutEpisode {
  id: string;
  orgId: string;
  documentId: string;
  libraryId: string | null;
  seq: number;
  status: "active" | "closed";
  openedAt: string;
  openedBy: string | null;
  openedByName: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closeReason: string | null;
}

/** The slice of a checkout_sessions row the state machine needs. */
export interface SessionLite {
  id: string;
  userId: string;
  userName: string | null;
  startedAt: string | null;
}

export type CheckInTransition =
  | { kind: "close" }
  | { kind: "transfer"; next: SessionLite }
  | { kind: "remain" };

// ─── Pure state machine ──────────────────────────────────────────────────

/**
 * Who inherits the lock when the current holder leaves? Deterministic:
 * the longest-running remaining session (earliest startedAt; ties broken by
 * id so two clients computing this concurrently agree).
 */
export function pickNextLockHolder(
  sessions: SessionLite[],
  leavingUserId: string,
): SessionLite | null {
  const remaining = sessions.filter((s) => s.userId !== leavingUserId);
  if (remaining.length === 0) return null;
  return [...remaining].sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : Number.MAX_SAFE_INTEGER;
    const tb = b.startedAt ? Date.parse(b.startedAt) : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * What happens to the episode + lock when `leavingUserId` checks in?
 *
 *   - close:    they were the last active participant → episode over.
 *   - transfer: they held the lock but others remain → pass the lock; the
 *               episode continues ("one long checkout session").
 *   - remain:   a non-holder collaborator left → lock untouched.
 *
 * `sessions` is the ACTIVE session list as fetched (it may still include the
 * leaver's rows; they're excluded here).
 */
export function computeCheckInTransition(input: {
  sessions: SessionLite[];
  leavingUserId: string;
  lockHolderId: string | null;
}): CheckInTransition {
  const remaining = input.sessions.filter((s) => s.userId !== input.leavingUserId);
  if (remaining.length === 0) return { kind: "close" };
  if (input.lockHolderId && String(input.lockHolderId) === String(input.leavingUserId)) {
    const next = pickNextLockHolder(input.sessions, input.leavingUserId);
    // remaining.length > 0 guarantees next exists, but stay defensive.
    return next ? { kind: "transfer", next } : { kind: "close" };
  }
  return { kind: "remain" };
}

/**
 * Rebuild the display list of collaborator names from the ACTIVE sessions —
 * never patch the old array. Read-modify-write of a possibly-stale list is
 * exactly how zombie collaborator entries were born.
 */
export function activeCollaboratorNames(sessions: SessionLite[]): string[] {
  const names = sessions
    .map((s) => (s.userName ?? "").trim())
    .filter((n) => n.length > 0);
  return [...new Set(names)];
}

/**
 * True when the error means the 20260729 episode schema isn't applied yet
 * (missing table or missing episode_id column). Callers degrade to legacy
 * behavior instead of failing the checkout.
 */
export function isMissingEpisodeSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  const msg = (e.message ?? "").toLowerCase();
  // 42P01 undefined_table / 42703 undefined_column (raw PG);
  // PGRST204 unknown column, PGRST205 unknown table (PostgREST schema cache).
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205") return true;
  return (
    (msg.includes("checkout_episodes") || msg.includes("episode_id")) &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"))
  );
}

// Once we know the schema is missing we stop retrying for the session —
// avoids a failed query per call on pre-migration environments.
let episodeSchemaMissing = false;

/** Test hook / manual reset (e.g. after the user applies the migration). */
export function resetEpisodeSchemaFlag(): void {
  episodeSchemaMissing = false;
}

/** Whether this environment has been detected as pre-migration (no episode
 *  schema). Only meaningful after at least one episode query has run. */
export function episodeSchemaIsMissing(): boolean {
  return episodeSchemaMissing;
}

// ─── Row mapping ─────────────────────────────────────────────────────────

export function rowToEpisode(r: Record<string, unknown>): CheckoutEpisode {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    libraryId: (r.library_id as string | null) ?? null,
    seq: (r.seq as number) ?? 1,
    status: (r.status as "active" | "closed") ?? "closed",
    openedAt: r.opened_at as string,
    openedBy: (r.opened_by as string | null) ?? null,
    openedByName: (r.opened_by_name as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    closedBy: (r.closed_by as string | null) ?? null,
    closedByName: (r.closed_by_name as string | null) ?? null,
    closeReason: (r.close_reason as string | null) ?? null,
  };
}

// ─── Episode lookup / creation ───────────────────────────────────────────

/** The document's live episode, or null (none active, or pre-migration env). */
export async function getActiveEpisode(
  documentId: string,
  opts?: { client?: SupabaseLike },
): Promise<CheckoutEpisode | null> {
  if (episodeSchemaMissing) return null;
  const db = opts?.client ?? supabase;
  const { data, error } = await db
    .from("checkout_episodes")
    .select("*")
    .eq("document_id", documentId)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    if (isMissingEpisodeSchema(error)) { episodeSchemaMissing = true; return null; }
    throw new Error(error.message);
  }
  return data ? rowToEpisode(data as Record<string, unknown>) : null;
}

/**
 * Find the live episode or open a new one. Concurrency-safe: the partial
 * unique index (one active episode per document) makes the loser of a
 * simultaneous "first checkout" race fail its insert and re-select the
 * winner's episode — i.e. it joins instead.
 *
 * Returns null only on pre-migration environments.
 */
export async function ensureActiveEpisode(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  userId: string;
  userName?: string | null;
  /** Backdate the open (used when adopting an in-flight legacy checkout). */
  openedAt?: string | null;
}): Promise<{ episode: CheckoutEpisode; created: boolean } | null> {
  if (episodeSchemaMissing) return null;

  const existing = await getActiveEpisode(input.documentId);
  if (existing) return { episode: existing, created: false };
  if (episodeSchemaMissing) return null; // set by getActiveEpisode

  // Next per-document number. Can't race itself: a second creator hits the
  // unique index below and re-selects rather than inserting seq'.
  const { data: lastRow } = await supabase
    .from("checkout_episodes")
    .select("seq")
    .eq("document_id", input.documentId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSeq = ((lastRow as { seq?: number } | null)?.seq ?? 0) + 1;

  const insertRow: Record<string, unknown> = {
    org_id: input.orgId,
    document_id: input.documentId,
    library_id: input.libraryId ?? null,
    seq: nextSeq,
    status: "active",
    opened_by: input.userId,
    opened_by_name: input.userName ?? null,
  };
  if (input.openedAt) insertRow.opened_at = input.openedAt;

  const { data, error } = await supabase
    .from("checkout_episodes")
    .insert(insertRow)
    .select("*")
    .single();

  if (error) {
    if (isMissingEpisodeSchema(error)) { episodeSchemaMissing = true; return null; }
    // 23505 = unique violation on the one-active-per-document index: someone
    // opened the episode a beat before us. Join theirs.
    if ((error as { code?: string }).code === "23505") {
      const winner = await getActiveEpisode(input.documentId);
      if (winner) return { episode: winner, created: false };
    }
    throw new Error(error.message);
  }
  return { episode: rowToEpisode(data as Record<string, unknown>), created: true };
}

/**
 * Adopt an IN-FLIGHT legacy checkout into the episode model: a document that
 * was checked out before the 20260729 migration has active sessions but no
 * episode. Give it one (backdated to the senior session's start) and tag the
 * live sessions, so chat works and close-out seals a proper record.
 *
 * Idempotent + race-safe (ensureActiveEpisode dedupes via the unique index;
 * the session tag only touches rows with episode_id IS NULL). Returns null
 * when there's nothing to adopt or the schema is missing.
 */
export async function adoptInFlightCheckout(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
}): Promise<CheckoutEpisode | null> {
  if (episodeSchemaMissing) return null;
  const sessions = await fetchActiveSessions(input.documentId);
  if (sessions.length === 0) return null;

  // The senior active session is the natural opener.
  const opener = pickNextLockHolder(sessions, "__nobody__");
  const ensured = await ensureActiveEpisode({
    orgId: input.orgId,
    documentId: input.documentId,
    libraryId: input.libraryId,
    userId: opener?.userId ?? "system",
    userName: opener?.userName ?? "System",
    openedAt: opener?.startedAt ?? null,
  });
  if (!ensured) return null;

  await supabase
    .from("checkout_sessions")
    .update({ episode_id: ensured.episode.id })
    .eq("document_id", input.documentId)
    .eq("status", "active")
    .is("episode_id", null);

  return ensured.episode;
}

/** Every episode for a document, newest first. Empty on pre-migration envs. */
export async function listEpisodesForDocument(
  documentId: string,
): Promise<CheckoutEpisode[]> {
  if (episodeSchemaMissing) return [];
  const { data, error } = await supabase
    .from("checkout_episodes")
    .select("*")
    .eq("document_id", documentId)
    .order("opened_at", { ascending: false });
  if (error) {
    if (isMissingEpisodeSchema(error)) { episodeSchemaMissing = true; return []; }
    throw new Error(error.message);
  }
  return ((data as Record<string, unknown>[]) ?? []).map(rowToEpisode);
}

async function closeEpisode(input: {
  episodeId: string;
  closedBy: string;
  closedByName?: string | null;
  reason: "checked_in" | "force_released" | "expired" | "reconciled";
  client?: SupabaseLike;
}): Promise<void> {
  if (episodeSchemaMissing) return;
  const db = input.client ?? supabase;
  const { error } = await db
    .from("checkout_episodes")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: input.closedBy,
      closed_by_name: input.closedByName ?? null,
      close_reason: input.reason,
    })
    .eq("id", input.episodeId)
    .eq("status", "active"); // CAS: only close a still-open episode
  if (error && !isMissingEpisodeSchema(error)) throw new Error(error.message);
}

// ─── System messages (episode-tagged) ────────────────────────────────────

/**
 * Insert a system event into the thread, tagged to the episode. Tolerates the
 * pre-migration env (drops episode_id and retries). Never throws — a missing
 * log line must not fail a check-in.
 */
export async function postEpisodeSystemMessage(input: {
  orgId: string;
  documentId: string;
  episodeId?: string | null;
  text: string;
  client?: SupabaseLike;
}): Promise<void> {
  const db = input.client ?? supabase;
  const base = {
    org_id: input.orgId,
    document_id: input.documentId,
    text: input.text,
    user_id: "system",
    user_name: "System",
    kind: "system",
  };
  try {
    const withEpisode = episodeSchemaMissing || !input.episodeId
      ? base
      : { ...base, episode_id: input.episodeId, lock_id: input.episodeId };
    const { error } = await db.from("checkout_messages").insert(withEpisode);
    if (error && isMissingEpisodeSchema(error)) {
      episodeSchemaMissing = true;
      await db.from("checkout_messages").insert(base);
    }
  } catch (e) {
    console.warn("[checkoutEpisodes] system message failed (non-blocking)", e);
  }
}

// ─── Fetching active sessions (shared) ───────────────────────────────────

async function fetchActiveSessions(
  documentId: string,
  client?: SupabaseLike,
): Promise<SessionLite[]> {
  const db = client ?? supabase;
  const { data, error } = await db
    .from("checkout_sessions")
    .select("id, user_id, user_name, started_at")
    .eq("document_id", documentId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return ((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
    id: r.id as string,
    userId: String(r.user_id),
    userName: (r.user_name as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
  }));
}

// ─── Check-in orchestration ──────────────────────────────────────────────

export interface FinishSessionResult {
  transition: CheckInTransition;
  episodeClosed: boolean;
  /** Name of the user the lock passed to, when transition.kind === "transfer". */
  transferredToName?: string | null;
}

/**
 * End the current user's active session(s) on a document and settle the
 * document + episode state:
 *
 *   last one out  → episode closes, every lock/collaborator column clears
 *   holder leaves → lock transfers to the longest-running remaining session
 *   joiner leaves → lock untouched, collaborator list rebuilt
 *
 * Posts the system events that give the thread its visible join/leave
 * timeline. Does NOT write audit rows — callers own their audit context.
 */
export async function finishMySession(input: {
  orgId: string;
  documentId: string;
  userId: string;
  userName: string;
  episodeId?: string | null;
  /** What the session row should say. Default "checked_in". */
  sessionStatus?: "checked_in" | "abandoned";
  releasedReason?: string | null;
}): Promise<FinishSessionResult> {
  const now = new Date().toISOString();

  // 1. End MY active session row(s) for this document.
  const { error: endErr } = await supabase
    .from("checkout_sessions")
    .update({
      status: input.sessionStatus ?? "checked_in",
      ended_at: now,
      released_at: now,
      released_by: input.userId,
      released_reason: input.releasedReason ?? null,
    })
    .eq("document_id", input.documentId)
    .eq("user_id", input.userId)
    .eq("status", "active");
  if (endErr) throw new Error(endErr.message);

  // 2. Who's still in? (My rows are already non-active, but recompute
  //    defensively — the transition helpers exclude the leaver anyway.)
  const sessions = await fetchActiveSessions(input.documentId);

  // 3. Authoritative lock holder AT THIS MOMENT (never trust a stale prop).
  const { data: docRow } = await supabase
    .from("documents")
    .select("checked_out_by")
    .eq("id", input.documentId)
    .maybeSingle();
  const lockHolderId = ((docRow as { checked_out_by?: string | null } | null)?.checked_out_by ?? null);

  const transition = computeCheckInTransition({
    sessions,
    leavingUserId: input.userId,
    lockHolderId: lockHolderId ? String(lockHolderId) : null,
  });

  const episode = input.episodeId
    ? { id: input.episodeId }
    : await getActiveEpisode(input.documentId);

  let episodeClosed = false;
  let transferredToName: string | null | undefined;

  if (transition.kind === "close") {
    // Last one out: clear everything; the episode becomes a sealed record.
    // Guarded: only clear when the lock is OURS or ALREADY NULL — a racer
    // who just checked out (new session + fresh lock) between our fetch and
    // this write must not have their lock wiped.
    await supabase
      .from("documents")
      .update({
        checked_out_by: null,
        checked_out_by_name: null,
        checked_out_at: null,
        checkout_note: null,
        current_lock_id: null,
        active_collaborators: [],
      })
      .eq("id", input.documentId)
      .or(`checked_out_by.is.null,checked_out_by.eq.${input.userId}`);
    if (episode?.id) {
      await closeEpisode({
        episodeId: episode.id,
        closedBy: input.userId,
        closedByName: input.userName,
        reason: "checked_in",
      });
      episodeClosed = true;
    }
    await postEpisodeSystemMessage({
      orgId: input.orgId,
      documentId: input.documentId,
      episodeId: episode?.id ?? null,
      text: `${input.userName} checked in — everyone is done, checkout closed.`,
    });
  } else if (transition.kind === "transfer") {
    // Holder leaves, others remain: pass the lock so the document never
    // reads "free" mid-episode. Fetch the heir's session details for the
    // lock badge (purpose/note).
    const heir = transition.next;
    transferredToName = heir.userName;
    const { data: heirRow } = await supabase
      .from("checkout_sessions")
      .select("purpose, note, started_at")
      .eq("id", heir.id)
      .maybeSingle();
    const heirSession = heirRow as { purpose?: string | null; note?: string | null; started_at?: string | null } | null;
    const heirNote = [heirSession?.purpose, heirSession?.note].filter(Boolean).join(" — ") || null;

    await supabase
      .from("documents")
      .update({
        checked_out_by: heir.userId,
        checked_out_by_name: heir.userName,
        checked_out_at: heirSession?.started_at ?? now,
        checkout_note: heirNote,
        active_collaborators: activeCollaboratorNames(
          sessions.filter((s) => s.userId !== input.userId),
        ),
      })
      .eq("id", input.documentId)
      // CAS: only if WE still appear as the holder — a concurrent force
      // release / re-checkout must not be clobbered by our stale view.
      .eq("checked_out_by", input.userId);

    const stillOut = activeCollaboratorNames(sessions.filter((s) => s.userId !== input.userId));
    await postEpisodeSystemMessage({
      orgId: input.orgId,
      documentId: input.documentId,
      episodeId: episode?.id ?? null,
      text: `${input.userName} checked in — lock passed to ${heir.userName ?? "the next collaborator"}. Still checked out: ${stillOut.join(", ")}.`,
    });
  } else {
    // A collaborator (not the holder) left: rebuild the display list only.
    const stillOut = activeCollaboratorNames(sessions.filter((s) => s.userId !== input.userId));
    await supabase
      .from("documents")
      .update({ active_collaborators: stillOut })
      .eq("id", input.documentId);
    await postEpisodeSystemMessage({
      orgId: input.orgId,
      documentId: input.documentId,
      episodeId: episode?.id ?? null,
      text: `${input.userName} checked in. Still checked out: ${stillOut.join(", ") || "—"}.`,
    });
  }

  return { transition, episodeClosed, transferredToName };
}

// ─── Force release (admin override) ──────────────────────────────────────

/**
 * Admin/DocCtrl override: end EVERY active session, close the episode with
 * close_reason 'force_released', clear the document columns, and log a
 * system alert into the thread. Callers write their own audit row.
 */
export async function forceReleaseDocument(input: {
  orgId: string;
  documentId: string;
  actorUserId: string;
  actorName: string;
  reason?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();

  await supabase
    .from("checkout_sessions")
    .update({
      status: "checked_in",
      ended_at: now,
      released_at: now,
      released_by: input.actorUserId,
      released_reason: input.reason ?? `Force released by ${input.actorName}`,
    })
    .eq("document_id", input.documentId)
    .eq("status", "active");

  const episode = await getActiveEpisode(input.documentId);

  await supabase
    .from("documents")
    .update({
      checked_out_by: null,
      checked_out_by_name: null,
      checked_out_at: null,
      checkout_note: null,
      current_lock_id: null,
      active_collaborators: [],
    })
    .eq("id", input.documentId);

  if (episode) {
    await closeEpisode({
      episodeId: episode.id,
      closedBy: input.actorUserId,
      closedByName: input.actorName,
      reason: "force_released",
    });
  }

  await postEpisodeSystemMessage({
    orgId: input.orgId,
    documentId: input.documentId,
    episodeId: episode?.id ?? null,
    text: `SYSTEM ALERT: checkout force-released by ${input.actorName}. All sessions ended.`,
  });
}

// ─── Reconcile (universal self-healing) ──────────────────────────────────

/**
 * Recompute a document's checkout columns FROM its active session rows —
 * the one true source. Heals every inconsistent shape:
 *
 *   no active sessions → clear lock + collaborators, close any stray episode
 *   sessions but holder isn't one of them → transfer lock to the senior session
 *   sessions + valid holder → rebuild the collaborator list only
 *
 * Used by the bulk/expiry paths after they end sessions, and by the modal's
 * zombie-state "Release Lock" repair button.
 */
export async function reconcileDocumentCheckoutState(
  documentId: string,
  opts?: {
    client?: SupabaseLike;
    orgId?: string;
    actorUserId?: string;
    actorName?: string;
    closeReason?: "checked_in" | "force_released" | "expired" | "reconciled";
  },
): Promise<void> {
  const db = opts?.client ?? supabase;
  const sessions = await fetchActiveSessions(documentId, db);

  if (sessions.length === 0) {
    await db
      .from("documents")
      .update({
        checked_out_by: null,
        checked_out_by_name: null,
        checked_out_at: null,
        checkout_note: null,
        current_lock_id: null,
        active_collaborators: [],
      })
      .eq("id", documentId);
    const episode = await getActiveEpisode(documentId, { client: db });
    if (episode) {
      await closeEpisode({
        episodeId: episode.id,
        closedBy: opts?.actorUserId ?? "system",
        closedByName: opts?.actorName ?? "System",
        reason: opts?.closeReason ?? "reconciled",
        client: db,
      });
      if (opts?.orgId) {
        await postEpisodeSystemMessage({
          orgId: opts.orgId,
          documentId,
          episodeId: episode.id,
          text:
            opts.closeReason === "expired"
              ? "Checkout auto-released — the session window expired. Checkout closed."
              : "Checkout closed — no active sessions remain.",
          client: db,
        });
      }
    }
    return;
  }

  const { data: docRow } = await db
    .from("documents")
    .select("checked_out_by")
    .eq("id", documentId)
    .maybeSingle();
  const holder = (docRow as { checked_out_by?: string | null } | null)?.checked_out_by ?? null;
  const holderStillActive = !!holder && sessions.some((s) => String(s.userId) === String(holder));
  const names = activeCollaboratorNames(sessions);

  if (holderStillActive) {
    await db.from("documents").update({ active_collaborators: names }).eq("id", documentId);
    return;
  }

  // Holder is gone (or never set) but sessions remain → senior session takes
  // the lock. pickNextLockHolder with an impossible "leaver" returns the
  // senior of the full list.
  const heir = pickNextLockHolder(sessions, "__nobody__");
  if (!heir) return;
  const { data: heirRow } = await db
    .from("checkout_sessions")
    .select("purpose, note, started_at")
    .eq("id", heir.id)
    .maybeSingle();
  const heirSession = heirRow as { purpose?: string | null; note?: string | null; started_at?: string | null } | null;
  await db
    .from("documents")
    .update({
      checked_out_by: heir.userId,
      checked_out_by_name: heir.userName,
      checked_out_at: heirSession?.started_at ?? new Date().toISOString(),
      checkout_note: [heirSession?.purpose, heirSession?.note].filter(Boolean).join(" — ") || null,
      active_collaborators: names,
    })
    .eq("id", documentId);
}
