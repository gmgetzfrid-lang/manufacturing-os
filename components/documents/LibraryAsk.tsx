"use client";

// LibraryAsk: "Needed from you" at the top of a library when the person came
// to recertify who has access to it (?ask=recert). The button opens the
// same check the library's tools menu opens (AccessRecertModal), where the
// access list is reviewed and confirmed.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/Button";
import { NeededFromYou } from "@/components/ui/NeededFromYou";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { describeRecert, listAccessGrants } from "@/lib/accessRecert";
import { dueWords, plainDate, daysFromToday } from "@/lib/asks";
import type { RecertPolicy } from "@/types/schema";

export default function LibraryAsk({ libraryId, orgId, name, refreshKey, onCheck }: {
  libraryId: string;
  orgId: string;
  name: string;
  /** Changes after the check is saved: read the dates again. */
  refreshKey?: number;
  onCheck: () => void;
}) {
  const [state, setState] = useState<{ policy: RecertPolicy | null; next: string | null; last: string | null; lastBy: string | null; grants: number } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [{ data: lib, error }, evt, grants] = await Promise.all([
        supabase.from("libraries").select("recert_policy, next_recertification_date, last_recertified_at").eq("id", libraryId).maybeSingle(),
        supabase.from("access_recertification_events").select("performed_by_name").eq("library_id", libraryId).order("performed_at", { ascending: false }).limit(1),
        listAccessGrants(orgId, libraryId).catch(() => []),
      ]);
      if (error) throw error;
      const by = ((evt.data ?? [])[0] as { performed_by_name?: string | null } | undefined)?.performed_by_name ?? null;
      setState({
        policy: (lib?.recert_policy as RecertPolicy | null) ?? null,
        next: (lib?.next_recertification_date as string | null) ?? null,
        last: (lib?.last_recertified_at as string | null) ?? null,
        lastBy: by ? by.split("@")[0] : null,
        grants: grants.length,
      });
    } catch (e) { setErr(e); }
  }, [libraryId, orgId]);
  useEffect(() => { void load(); }, [load, tick, refreshKey]);

  if (err) return <ErrorNote error={err} title="Couldn't check this library's access recertification." onRetry={() => setTick((n) => n + 1)} />;
  if (!state) return <NeededFromYou what="" loading />;
  const days = daysFromToday(state.next);
  if (!state.next || (days != null && days > 30)) {
    return <NeededFromYou done what={<>Access to {name} is recertified.{state.next ? ` The next check is due ${plainDate(state.next)}.` : ""}</>} />;
  }
  const due = dueWords(state.next);
  return (
    <NeededFromYou
      what={<>Access recertification {due?.late ? "overdue" : "due"} {plainDate(state.next)}: check who can open {name} and confirm it&apos;s still right.</>}
      why={<>
        {describeRecert(state.policy)}. {state.last ? <>Last recertified {plainDate(state.last)}{state.lastBy ? ` by ${state.lastBy}` : ""}.</> : <>Not recertified yet.</>}{" "}
        {state.grants} {state.grants === 1 ? "person, role or team has" : "people, roles or teams have"} access now.
      </>}
      when={due}
      note={<>The check lists everyone with access. Remove anyone who shouldn&apos;t have it, then confirm.</>}
    >
      <Button onClick={onCheck}>Check who has access</Button>
    </NeededFromYou>
  );
}
