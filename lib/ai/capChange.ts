// lib/ai/capChange.ts — SERVER-ONLY. One change to a monthly AI cap (GOV-15).
//
// THE path is ai_cap_change (migration 20261173): ONE SECURITY DEFINER
// function that takes the workspace's cap-change lock, locks the default row
// and the override rows it reads (FOR UPDATE), decides the self-raise ban
// against the figures it locked, writes, and appends AI_CAP_CHANGED — one
// transaction. Two cap changes in flight therefore run one after the other,
// each deciding from what the other committed; nothing is re-read or put back
// afterwards. Inside that lock a holder's self-clear that is not a raise (the
// default is at or below their override) is allowed again, as it was at
// 052271b — refusing it existed only because racing it against a default
// raise once deleted the hold the raise had just written.
//
// Until 20261173 is pasted (PostgREST PGRST202 / Postgres 42883: the function
// is not there) the change runs app-side (`applyCapChangeAppSide`): the same
// reads, decisions, writes, answers and audit rows as before GOV-15 for
// requests made one after another — GOV-10's sequential matrix — WITHOUT the
// race machinery GOV-10's fix passes 5–10 added (it narrowed the windows; it
// never closed them, and GOV-15 replaces it). Two changes in flight at once
// are not serialised on that path, so it keeps refusing a holder's own
// self-clear while another holder exists; the server log says, once, that
// the cap change ran app-side and which migration closes it.
//
// Both paths answer the same `CapChangeOutcome`; the route maps it onto the
// response and the bell notices (the notices are best-effort and run after
// the change, as they always have).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCapUsd, displayCapUsd, DEFAULT_MONTHLY_CAP_USD } from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";

/** The cap-change function (20261173). */
export const CAP_CHANGE_FUNCTION = "ai_cap_change";

/** GOV-10: a uuid in any spelling Postgres's uuid input accepts — upper or
 *  lower case, wrapped in braces, a hyphen after any group of four digits
 *  or none — as the canonical lowercase 8-4-4-4-12 form; null for anything
 *  else. The uuid columns match every one of those spellings, so a
 *  comparison against the caller's own id must never use the request's. */
export function canonicalUuid(raw: string): string | null {
  const braced = /^\{(.*)\}$/.exec(raw);
  const body = braced ? braced[1] : raw;
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(body)) return null;
  const hex = body.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The same member, whatever the spelling (ids that are not uuids compare as written). */
export const sameUid = (a: string, b: string) => (canonicalUuid(a) ?? a) === (canonicalUuid(b) ?? b);

export const limitsTableMissing = (e: { code?: string; message: string }) =>
  e.code === "42P01" || /does not exist/i.test(e.message);

/** A unique-index refusal: another request wrote the same row first. */
const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505";

// ── The sentences both paths answer with ────────────────────────────────────

export const SELF_RAISE = "You can't raise your own monthly AI cap — another person with the “Manage AI spend caps” permission has to.";
/** App-side: a self-clear is refused outright while another holder exists. */
export const SELF_CLEAR = "You can't clear your own monthly AI cap override while another person has the “Manage AI spend caps” permission — set a lower figure for yourself directly, or ask them to change it.";
/** ai_cap_change: only a self-clear that would RAISE the cap is refused. */
export const SELF_CLEAR_RAISE = "You can't clear your own monthly AI cap override while another person has the “Manage AI spend caps” permission: the workspace default is higher, so clearing it would raise your cap — ask them to change it.";
export const SOLE_AUDIT_FAILED = "Couldn't write the audit record that raising your own cap without a second signature needs, so nothing was changed";
export const rosterRefusal = (error: string) => `Couldn't check who else manages AI caps, so nothing was changed: ${error}`;

// ── The request and its outcome ─────────────────────────────────────────────

export interface CapChangeRequest {
  orgId: string;
  /** Who changes it (auth.userId). */
  actorId: string;
  /** The person whose override changes — the uid the DATABASE returned for
   *  them, never the request's spelling; null = the workspace default. */
  targetUserId: string | null;
  /** The new figure (0 = a lock); null for a clear. Validated by the caller. */
  capUsd: number | null;
  /** Clear the target's override (they follow the default again). */
  clear: boolean;
  /** Whether another ACTIVE member holds ai.manage_caps — the second
   *  signature a self-raise needs; null when the roster could not be read
   *  (never "nobody else"). */
  otherHolders: boolean | null;
  /** Why the roster could not be read (said in the refusal). */
  rosterError: string | null;
}

export type CapChangeOutcome =
  | {
    kind: "refused"; status: number; error: string; extra?: Record<string, unknown>;
    /** App-side only: a hold a default raise wrote stayed after the raise
     *  failed (it could not be taken back out) — a change to the setter's
     *  cap the other holders are told about. */
    holdKept?: { atUsd: number; reason: string };
  }
  | { kind: "unchanged"; clear: boolean; capUsd: number | null }
  | {
    kind: "changed"; clear: boolean; capUsd: number | null; previousCapUsd: number;
    soleHolder: boolean; pinnedAtDefault: boolean;
    /** The hold a default raise wrote for its setter (they follow the
     *  default no longer), or null. */
    heldSelfAtUsd: number | null;
    /** Audit rows the change could not write in its own transaction (the
     *  log refused them): tried again once, best-effort, as every other
     *  change's row is. Never a sole holder's own raise — that one is the
     *  record, and it is refused unrecorded. */
    auditRetry: Array<Record<string, unknown>>;
  };

/** Write one AI_CAP_CHANGED row; the reason when it was not written. */
export async function auditCapChange(orgId: string, actorId: string, details: Record<string, unknown>): Promise<string | null> {
  try {
    const { error } = await supabaseAdmin.from("audit_logs").insert({
      action: "AI_CAP_CHANGED",
      resource_type: "ai_usage_limit", resource_id: orgId,
      org_id: orgId, user_id: actorId,
      details,
    });
    return error ? (error.message || "the audit log refused the row") : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The stored workspace default (display figure: 0 = locked), $10 when no
 *  row exists; an error when the table cannot be read. */
export async function readOrgDefault(orgId: string): Promise<
  | { ok: true; capUsd: number; exists: boolean; tableMissing: boolean }
  | { ok: false; error: string }
> {
  const { data, error } = await supabaseAdmin.from("ai_usage_limits")
    .select("monthly_cap_usd").eq("org_id", orgId).is("user_id", null).maybeSingle();
  if (error && !limitsTableMissing(error)) return { ok: false, error: error.message };
  const row = data as { monthly_cap_usd?: number | string | null } | null;
  const stored = row?.monthly_cap_usd ?? null;
  const raw = Number(stored);
  return {
    ok: true,
    capUsd: stored !== null && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CAP_USD,
    exists: !!data, tableMissing: !!error,
  };
}

/** A member's cap now (display figure: 0 = locked); null when it cannot be read. */
async function readCapOf(orgId: string, userId: string): Promise<number | null> {
  try { return displayCapUsd(await getCapUsd(orgId, userId)); }
  catch (e) {
    if (e instanceof GovernedCallError) return null;
    throw e;
  }
}

// ── The function (20261173) ─────────────────────────────────────────────────

/** PostgREST's answer for a function that does not exist yet (PGRST202 — its
 *  schema cache) or Postgres' undefined_function naming this one (a 42883
 *  raised INSIDE a deployed body names something else and is a failure). */
export function isMissingCapChangeFunction(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  const code = String(e.code ?? "");
  if (code === "PGRST202") return true;
  return code === "42883" && new RegExp(`${CAP_CHANGE_FUNCTION}`).test(e.message ?? "")
    || /could not find the function .*ai_cap_change/i.test(e.message ?? "");
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The function's jsonb answer → the outcome both paths share. */
export function outcomeFromFunction(data: unknown, req: CapChangeRequest): CapChangeOutcome {
  const d = (data ?? {}) as Record<string, unknown>;
  const clear = req.clear;
  if (d.outcome === "unchanged") return { kind: "unchanged", clear, capUsd: clear ? null : num(d.cap_usd) };
  if (d.outcome === "refused") {
    switch (d.reason) {
      case "self_raise": return { kind: "refused", status: 403, error: SELF_RAISE };
      case "self_clear": return { kind: "refused", status: 403, error: SELF_CLEAR_RAISE };
      case "roster_unreadable": return { kind: "refused", status: 503, error: rosterRefusal(req.rosterError ?? "the holder roster was not read") };
      case "sole_audit_failed": return { kind: "refused", status: 503, error: `${SOLE_AUDIT_FAILED}: ${String(d.error ?? "the audit log refused the row")}` };
      default: return { kind: "refused", status: 500, error: `Couldn't save the cap: the cap-change function refused it (${String(d.reason ?? "no reason given")}).` };
    }
  }
  if (d.outcome !== "changed") {
    return { kind: "refused", status: 500, error: "Couldn't save the cap: the cap-change function gave no answer the app understands." };
  }
  const retry = Array.isArray(d.audit_retry) ? (d.audit_retry as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
  return {
    kind: "changed", clear,
    capUsd: clear ? null : num(d.cap_usd),
    previousCapUsd: num(d.previous_cap_usd) ?? DEFAULT_MONTHLY_CAP_USD,
    soleHolder: d.sole_holder === true,
    pinnedAtDefault: d.pinned_at_default === true,
    heldSelfAtUsd: num(d.held_self_at_usd),
    auditRetry: retry,
  };
}

/** Run the change through ai_cap_change. `missing` when the database has no
 *  such function yet (the caller then takes the app-side path); `failed`
 *  when it refused or errored — the transaction rolled back, so nothing
 *  changed (a transport error after a commit is the one exception: the
 *  change's own AI_CAP_CHANGED row then says it landed). */
export async function callCapChangeFunction(req: CapChangeRequest): Promise<
  { kind: "missing" } | { kind: "failed"; error: string } | { kind: "done"; outcome: CapChangeOutcome }
> {
  let res: { data: unknown; error: { code?: string; message: string } | null };
  try {
    res = await supabaseAdmin.rpc(CAP_CHANGE_FUNCTION, {
      p_org_id: req.orgId,
      p_actor: req.actorId,
      p_target: req.targetUserId,
      p_cap_usd: req.clear ? null : req.capUsd,
      p_clear: req.clear,
      p_other_holders: req.otherHolders,
    }) as typeof res;
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  if (res.error) {
    if (isMissingCapChangeFunction(res.error)) return { kind: "missing" };
    return { kind: "failed", error: res.error.message || "the cap-change function failed" };
  }
  return { kind: "done", outcome: outcomeFromFunction(res.data, req) };
}

// ── App-side, until 20261173 is pasted ──────────────────────────────────────

let saidAppSide = false;
/** Said once per server process: the cap change ran without the lock. */
export function sayAppSideOnce() {
  if (saidAppSide) return;
  saidAppSide = true;
  console.warn("AI cap changes are running app-side: migration 20261173 (ai_cap_change) is not applied, so two cap changes in flight at once are not serialised. Paste it in the Supabase SQL editor.");
}

/** GOV-10 / GOV-15: the change made app-side — today's sequential reads,
 *  decisions, writes, answers and audit rows, with no re-read and no
 *  put-back. The ban (nobody raises their OWN cap while another active
 *  member holds ai.manage_caps) is decided from what was read: an override,
 *  clearing one (refused outright while another holder exists — this path
 *  has no lock), and raising the default one follows (the setter is held at
 *  their cap by an override written before the default moves). A SOLE
 *  holder's own raise is recorded first and checked — the only control on
 *  it — and a save that then fails writes the record's `notApplied`
 *  companion. Every other change is audited after it lands, best-effort. */
export async function applyCapChangeAppSide(req: CapChangeRequest): Promise<CapChangeOutcome> {
  const { orgId, actorId, targetUserId } = req;
  const selfTarget = targetUserId !== null && sameUid(targetUserId, actorId);
  const refuse = (status: number, error: string, extra?: Record<string, unknown>): CapChangeOutcome =>
    ({ kind: "refused", status, error, ...(extra ? { extra } : {}) });

  // The cap that applies to the target before this change (display figure:
  // 0 = locked) — the self-raise test and the notice both read it.
  let previousCapUsd: number;
  let defaultRead: Extract<Awaited<ReturnType<typeof readOrgDefault>>, { ok: true }> | null = null;
  if (targetUserId) {
    try { previousCapUsd = displayCapUsd(await getCapUsd(orgId, targetUserId)); }
    catch (e) {
      if (e instanceof GovernedCallError) return refuse(e.status, e.message);
      throw e;
    }
  } else {
    const prev = await readOrgDefault(orgId);
    if (!prev.ok) return refuse(503, `Couldn't read the current default cap, so nothing was changed: ${prev.error}`);
    previousCapUsd = prev.capUsd;
    defaultRead = prev;
  }
  const selfRaise = (next: number) => selfTarget && next > previousCapUsd;
  let soleHolder = false;

  // ── Clearing a per-person override: they follow the default again ───────
  if (req.clear && targetUserId) {
    if (selfTarget) {
      if (req.otherHolders === null) return refuse(503, rosterRefusal(req.rosterError ?? "unknown error"));
      if (req.otherHolders) {
        const { data: own, error: ownError } = await supabaseAdmin.from("ai_usage_limits")
          .select("id").eq("org_id", orgId).eq("user_id", targetUserId).maybeSingle();
        if (ownError && !limitsTableMissing(ownError)) {
          return refuse(503, `Couldn't read your own cap override, so nothing was changed: ${ownError.message}`);
        }
        if (!own) return { kind: "unchanged", clear: true, capUsd: null };
        return refuse(403, SELF_CLEAR);
      }
    }
    // The self-raise test reads the default: unreadable → nothing changes.
    const def = await readOrgDefault(orgId);
    if (!def.ok) return refuse(503, `Couldn't read the default cap, so the override was not cleared: ${def.error}`);
    // Only a sole holder reaches a self-raise here.
    if (selfRaise(def.capUsd)) soleHolder = true;
    const details = { targetUserId, cleared: true, previousCapUsd, ...(soleHolder ? { soleHolder: true } : {}) };
    if (soleHolder) {
      const auditError = await auditCapChange(orgId, actorId, details);
      if (auditError) return refuse(503, `${SOLE_AUDIT_FAILED}: ${auditError}`);
    }
    const { data: removed, error } = await supabaseAdmin
      .from("ai_usage_limits").delete()
      .eq("org_id", orgId).eq("user_id", targetUserId).select("id");
    const removedRows = ((removed as unknown[] | null) ?? []).length;
    if (error) {
      // The audit row already says it happened: say it did not.
      if (soleHolder) await auditCapChange(orgId, actorId, { ...details, notApplied: true, error: error.message });
      return refuse(500, `Couldn't clear the cap override: ${error.message}`);
    }
    // There was no override to clear — the person already follows the
    // default: nothing changed, so nothing is audited or told.
    if (removedRows === 0) {
      if (soleHolder) await auditCapChange(orgId, actorId, { ...details, notApplied: true, error: "there was no override to clear" });
      return { kind: "unchanged", clear: true, capUsd: null };
    }
    if (!soleHolder) await auditCapChange(orgId, actorId, details);
    return {
      kind: "changed", clear: true, capUsd: null, previousCapUsd, soleHolder,
      pinnedAtDefault: false, heldSelfAtUsd: null, auditRetry: [],
    };
  }

  // ── Setting a figure ────────────────────────────────────────────────────
  const capUsd = req.capUsd as number;
  if (selfRaise(capUsd)) {
    if (req.otherHolders === null) return refuse(503, rosterRefusal(req.rosterError ?? "unknown error"));
    if (req.otherHolders) return refuse(403, SELF_RAISE);
    soleHolder = true;
  }
  if (defaultRead?.tableMissing) {
    return refuse(424, "The ai_usage_limits table doesn't exist yet — run migration 20260916 in Supabase first.");
  }
  // The workspace default already at this figure: nothing changes for anyone.
  if (!targetUserId && capUsd === previousCapUsd) return { kind: "unchanged", clear: false, capUsd };

  // The setter's own cap before a change to the default — the most a hold
  // may hold them at.
  let ownBeforeUsd: number | null = selfTarget ? previousCapUsd : null;
  if (!targetUserId) {
    ownBeforeUsd = await readCapOf(orgId, actorId);
    if (ownBeforeUsd === null) {
      return refuse(503, "Couldn't read your own cap, so the default was not changed — AI caps can't be read right now.");
    }
  }

  // GOV-10: raising the WORKSPACE default must not raise the setter's own
  // cap. A setter whose cap follows the default (no override of their own)
  // is held where they are — an override written BEFORE the default moves,
  // at the lower of the default and their own cap as read. A sole holder is
  // not held: they follow the default like everyone else.
  const defaultRaise = !targetUserId && capUsd > previousCapUsd;
  let pinAt: number | null = null;
  if (defaultRaise) {
    const { data: own, error: ownError } = await supabaseAdmin.from("ai_usage_limits")
      .select("id").eq("org_id", orgId).eq("user_id", actorId).maybeSingle();
    if (ownError && !limitsTableMissing(ownError)) {
      return refuse(503, `Couldn't read your own cap, so the default was not changed: ${ownError.message}`);
    }
    if (!own && !ownError) {
      if (req.otherHolders === null) return refuse(503, rosterRefusal(req.rosterError ?? "unknown error"));
      if (req.otherHolders) pinAt = Math.min(previousCapUsd, ownBeforeUsd ?? previousCapUsd);
      else soleHolder = true;
    }
  }

  // Whether the row exists: the default's was read above; a person's here.
  let rowExists: boolean;
  if (targetUserId) {
    const { data: existing, error: readError } = await supabaseAdmin.from("ai_usage_limits")
      .select("id, monthly_cap_usd").eq("org_id", orgId).eq("user_id", targetUserId).maybeSingle();
    if (readError) {
      const missing = limitsTableMissing(readError);
      return refuse(
        missing ? 424 : 500,
        missing
          ? "The ai_usage_limits table doesn't exist yet — run migration 20260916 in Supabase first."
          : `Couldn't read the current cap: ${readError.message}`,
      );
    }
    rowExists = !!existing;
    // The person's own override already holds this figure: nothing changes.
    // (A person who follows the default and is given its figure as their
    // own is a change — the default no longer moves them.)
    const stored = (existing as { monthly_cap_usd?: number | string | null } | null)?.monthly_cap_usd;
    if (rowExists && stored !== null && stored !== undefined && Number(stored) === capUsd && previousCapUsd === capUsd) {
      return { kind: "unchanged", clear: false, capUsd };
    }
  } else {
    rowExists = (defaultRead as NonNullable<typeof defaultRead>).exists;
  }
  const pinnedAtDefault = !!targetUserId && !rowExists && capUsd === previousCapUsd;
  const details: Record<string, unknown> = {
    ...(targetUserId ? { targetUserId } : {}), capUsd, previousCapUsd,
    ...(soleHolder ? { soleHolder: true } : {}),
    ...(pinnedAtDefault ? { pinnedAtDefault: true } : {}),
  };
  // A sole holder's own raise is recorded BEFORE it is made: its row is the
  // only control on it, so one the log refuses changes nothing.
  if (soleHolder) {
    const auditError = await auditCapChange(orgId, actorId, details);
    if (auditError) return refuse(503, `${SOLE_AUDIT_FAILED}: ${auditError}`);
  }
  const fields = { monthly_cap_usd: capUsd, updated_by: actorId, updated_at: new Date().toISOString() };
  if (pinAt !== null) {
    const { error: pinError } = await supabaseAdmin.from("ai_usage_limits").insert({
      org_id: orgId, user_id: actorId, ...fields, monthly_cap_usd: pinAt,
    });
    if (pinError) {
      return refuse(
        isUniqueViolation(pinError) ? 409 : 500,
        `Couldn't hold your own cap at its current figure, so the default was not raised: ${pinError.message}`,
      );
    }
  }

  let saveError: { code?: string; message: string } | null = null;
  let conflict = false;
  if (rowExists) {
    let write = supabaseAdmin.from("ai_usage_limits").update(fields).eq("org_id", orgId);
    write = targetUserId ? write.eq("user_id", targetUserId) : write.is("user_id", null);
    const { data: written, error } = await write.select("id");
    saveError = error;
    // The row read moments ago is gone: never a success over nothing.
    if (!error && ((written as unknown[] | null) ?? []).length === 0) conflict = true;
  } else {
    const { error } = await supabaseAdmin.from("ai_usage_limits")
      .insert({ org_id: orgId, user_id: targetUserId, ...fields });
    saveError = error;
  }
  if (saveError || conflict) {
    conflict = conflict || isUniqueViolation(saveError);
    const why = saveError?.message || "the cap changed while this was being saved";
    // The sole holder's record already says it happened: say it did not.
    if (soleHolder) await auditCapChange(orgId, actorId, { ...details, notApplied: true, error: why });
    let holdKept: { atUsd: number; reason: string } | undefined;
    let ownSaid = "";
    const extra: Record<string, unknown> = conflict ? { conflict: true } : {};
    // The hold was written for a raise that did not happen: it comes back
    // out, as written. One that cannot be taken out stays, and is said.
    if (pinAt !== null) {
      const { data: undone, error: undoError } = await supabaseAdmin.from("ai_usage_limits").delete()
        .eq("org_id", orgId).eq("user_id", actorId).eq("monthly_cap_usd", pinAt)
        .eq("updated_by", actorId).select("id");
      // No row matched: the hold is no longer this change's to take out
      // (another change already replaced it), so it is not kept and nothing
      // is said — as before.
      const undoneRows = ((undone as unknown[] | null) ?? []).length;
      if (undoError && undoneRows === 0) {
        const reason = `it could not be taken back out (${undoError.message})`;
        holdKept = { atUsd: pinAt, reason };
        await auditCapChange(orgId, actorId, {
          targetUserId: actorId, capUsd: pinAt, previousCapUsd: ownBeforeUsd ?? previousCapUsd,
          heldOnDefaultRaise: true, defaultNotRaised: true, holdKept: reason, error: why,
        });
        ownSaid = ` Your own cap stays held at ${pinAt === 0 ? "$0 (locked)" : `$${pinAt}`}: ${reason}, so you no longer follow the workspace default — ask another person who manages AI caps to clear it if you should.`;
        extra.holdKept = true;
      }
    }
    if (conflict) {
      const head = targetUserId
        ? "That cap changed while you were saving it (another change landed at the same time)"
        : "The workspace default changed while you were saving it (another change landed at the same time)";
      return {
        kind: "refused", status: 409, extra,
        error: ownSaid ? `${head}, so it was not changed.${ownSaid} Reload the caps and try again.`
          : `${head}, so nothing was changed — reload the caps and try again.`,
        ...(holdKept ? { holdKept } : {}),
      };
    }
    return {
      kind: "refused", status: 500, extra,
      error: `Couldn't save the cap: ${why}${ownSaid ? `.${ownSaid}` : ""}`,
      ...(holdKept ? { holdKept } : {}),
    };
  }

  // Landed: the change's row, then the hold's (the order the log has always
  // read in: the raise, then the hold it wrote). Best-effort, as before. A
  // default raise's row keeps the two tries it had before GOV-15 — it was
  // written first (for the race reader GOV-15 deletes) and, when the log
  // refused it, tried again once the raise had landed — so a log that
  // refuses it once still holds it once; every other row gets one try.
  if (!soleHolder) {
    const auditError = await auditCapChange(orgId, actorId, details);
    if (auditError && defaultRaise) await auditCapChange(orgId, actorId, details);
  }
  if (pinAt !== null) {
    await auditCapChange(orgId, actorId, {
      targetUserId: actorId, capUsd: pinAt, previousCapUsd: ownBeforeUsd ?? previousCapUsd, heldOnDefaultRaise: true,
    });
  }
  return {
    kind: "changed", clear: false, capUsd, previousCapUsd, soleHolder, pinnedAtDefault,
    heldSelfAtUsd: pinAt, auditRetry: [],
  };
}
