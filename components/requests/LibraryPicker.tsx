"use client";

// components/requests/LibraryPicker.tsx
//
// drafting-flow Round G, DF-P4 LIBRARY — GAP-105 / DCW-1: the triage-time
// library picker. Triage sets (or corrects) the library a request targets
// with `assign` / `request_eng_review` at PENDING_ASSIGNMENT
// (/api/tickets/workflow-action, body.libraryId). It offers only the
// libraries the CALLER may discover (lib/ticketLibrary.ts
// offerableLibraries → lib/permissions canDiscover): a library the assigner
// cannot see is never offered — and the route refuses one by the same rule,
// on a principal it builds itself, whatever a client sends. "No library — decide later" is always there
// and is the default when the request has none: a library is never required
// (99-fix-sequencing Phase 2 item 1).
//
// The ticket's CURRENT library may be one the assigner cannot discover (a
// requester's discover grant set it from the linked document, DCW-5): it is
// then shown as one extra option, "the target library (current)", never by
// name and never as "No library". Sent back unchanged it is no change — the
// route skips its check for the ticket's own library (DF-P4 second fix pass).
//
// DF-P4 third fix pass — a library is never CLEARED at triage: the route
// reads a null / empty libraryId as "no change" and computeTransition can
// only set library_id. So on a ticket that already has a library
// (`currentLibraryId`), the picker offers NO "No library" choice — it would
// be a clear the server silently does not make. It offers the current
// library (by name when the assigner may discover it, else as "the target
// library (current)") and the libraries the assigner may switch to; the
// current option is keyed on `currentLibraryId`, not on the live `value`,
// so it can be chosen again after the selection moves away. A null `value`
// on such a ticket shows the current library selected (sending null, or
// the current id, is the same no-change).
//
// Mounted by DF-P9 in the assign modal, one line:
//   <LibraryPicker orgId={ticket.orgId} currentLibraryId={ticket.libraryId ?? null}
//                  value={libraryId} onChange={setLibraryId} />
// (`libraryId` may be initialised from ticket.libraryId) and the modal sends
// `libraryId` with the action.

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { getMyTeamIds } from "@/lib/teams";
import { offerableLibraries, type LibraryChoiceRow } from "@/lib/ticketLibrary";
import type { Principal } from "@/lib/permissions";

export const NO_LIBRARY_LABEL = "No library — decide later";
export const CURRENT_HIDDEN_LIBRARY_LABEL = "the target library (current)";

export interface LibraryPickerProps {
  orgId: string;
  value: string | null;
  onChange: (libraryId: string | null) => void;
  disabled?: boolean;
  /** The label shown above the select. */
  label?: string;
  /** The ticket's stored library (ticket.libraryId). Set → no "No library"
   *  choice (triage never clears a library) and the current library stays
   *  selectable whatever `value` is now. */
  currentLibraryId?: string | null;
}

export function LibraryPicker({ orgId, value, onChange, disabled, label = "Target library", currentLibraryId = null }: LibraryPickerProps) {
  const { uid, activeRole, roles } = useRole();
  const [rows, setRows] = useState<LibraryChoiceRow[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // What the last load answered, and for which workspace: a load still in
  // flight for the current workspace reads as "loading".
  const [loaded, setLoaded] = useState<{ orgId: string; ok: boolean } | null>(null);
  const state: "loading" | "ready" | "error" = loaded?.orgId !== orgId ? "loading" : loaded.ok ? "ready" : "error";

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data, error }, teams] = await Promise.all([
        supabase.from("libraries").select("id, name, visibility, acl, owner_user_id").eq("org_id", orgId),
        uid ? getMyTeamIds(uid) : Promise.resolve([] as string[]),
      ]);
      if (!alive) return;
      if (error) { setLoaded({ orgId, ok: false }); return; }
      setTeamIds(teams);
      setRows(((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id ?? ""),
        name: (r.name as string | null) ?? null,
        visibility: (r.visibility as string | null) ?? null,
        acl: (r.acl as LibraryChoiceRow["acl"]) ?? null,
        ownerUserId: (r.owner_user_id as string | null) ?? null,
      })));
      setLoaded({ orgId, ok: true });
    })().catch(() => { if (alive) setLoaded({ orgId, ok: false }); });
    return () => { alive = false; };
  }, [orgId, uid]);

  // SESS-6: no role known → no principal → nothing offered.
  const principal = useMemo<Principal | null>(() => (
    activeRole === null ? null : { uid: uid ?? "", role: activeRole, roles, orgId, teamIds }
  ), [uid, activeRole, roles, orgId, teamIds]);
  const options = useMemo(() => offerableLibraries(rows, principal), [rows, principal]);
  const current = currentLibraryId || null;
  const selected = value ?? current ?? "";
  // A library id the list does not offer — the ticket's current one, or a
  // value the modal was given — is shown without its name.
  const hiddenIds = [current, value].filter((id, i, all): id is string =>
    !!id && all.indexOf(id) === i && !options.some((o) => o.id === id));

  return (
    <label className="block">
      <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1">{label}</span>
      <select
        data-testid="library-picker"
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
        value={selected}
        disabled={disabled || state === "loading"}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
      >
        {!current && <option value="">{NO_LIBRARY_LABEL}</option>}
        {hiddenIds.map((id) => (
          <option key={`current-${id}`} value={id}>{CURRENT_HIDDEN_LIBRARY_LABEL}</option>
        ))}
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {state === "error" && (
        <span role="alert" className="block text-[11px] text-amber-700 mt-1">
          Couldn&apos;t load this workspace&apos;s libraries — the request can still be assigned with no library.
        </span>
      )}
    </label>
  );
}

export default LibraryPicker;
