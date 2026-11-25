// lib/orgPresence.ts - who is in the app right now, and what they're in
// ("Viewing 5602-D 1000", "In Transmix-1/2 TAR"), for the side menu's
// "On now".
//
// Supabase Realtime presence, the same mechanism the app already uses for
// "others viewing" on a document or project (lib/presence): no database
// rows, no writes; it lives in the realtime server's memory and ends when
// the tab closes. One channel per workspace.
//
// What a person is in: a page that knows (a document, a project) says so
// with setPresenceWhere; otherwise the side menu passes the tool's name
// ("In Documents").

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";

export interface PresenceWhere {
  /** "Viewing", "In". */
  verb: string;
  /** "5602-D 1000", "Transmix-1/2 TAR". */
  label: string;
  /** Where tapping the person goes. */
  href?: string;
}

export interface OnNowPerson {
  userId: string;
  name: string;
  where: PresenceWhere | null;
  /** When they came online (ISO). */
  since: string;
}

let pageWhere: PresenceWhere | null = null;
const whereListeners = new Set<() => void>();

/** What this person is looking at, said by the page that knows (null when
 *  they leave it). */
export function setPresenceWhere(where: PresenceWhere | null): void {
  pageWhere = where;
  for (const l of whereListeners) l();
}

function usePageWhere(): PresenceWhere | null {
  return useSyncExternalStore(
    (l) => { whereListeners.add(l); return () => { whereListeners.delete(l); }; },
    () => pageWhere,
    () => null,
  );
}

type Meta = { userId?: string; name?: string; where?: PresenceWhere | null; since?: string };

/**
 * The other people in this workspace right now (not you), newest first.
 * Null until the channel answers. `fallback` is where you are when the page
 * doesn't say (the tool's name).
 */
export function useOrgPresence(
  orgId: string | null | undefined,
  me: { userId: string | null | undefined; name: string },
  fallback: PresenceWhere | null,
): OnNowPerson[] | null {
  const [others, setOthers] = useState<OnNowPerson[] | null>(null);
  const page = usePageWhere();
  const where = page ?? fallback;
  const channel = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const joined = useRef(false);
  const since = useRef(new Date().toISOString());
  const latest = useRef({ name: me.name, where });
  // Kept current for the channel callbacks (set after render, before the
  // effects below run).
  useEffect(() => { latest.current = { name: me.name, where }; });
  const uid = me.userId;

  useEffect(() => {
    if (!orgId || !uid) return;
    const ch = supabase.channel(`presence:org:${orgId}`, { config: { presence: { key: uid } } });
    channel.current = ch;
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState() as Record<string, Meta[]>;
      const people: OnNowPerson[] = [];
      for (const [key, metas] of Object.entries(state)) {
        if (key === uid || !metas.length) continue;
        // Several tabs: the one that moved last says where they are.
        const m = metas[metas.length - 1];
        people.push({ userId: m.userId ?? key, name: m.name || "Someone", where: m.where ?? null, since: m.since ?? "" });
      }
      people.sort((a, b) => b.since.localeCompare(a.since));
      setOthers(people);
    }).subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      joined.current = true;
      void ch.track({ userId: uid, name: latest.current.name, where: latest.current.where, since: since.current });
    });
    return () => {
      joined.current = false;
      channel.current = null;
      void supabase.removeChannel(ch);
    };
  }, [orgId, uid]);

  // Moving around: say where, a moment after settling (not on every click).
  const whereKey = where ? `${where.verb}|${where.label}|${where.href ?? ""}` : "";
  useEffect(() => {
    if (!joined.current || !uid) return;
    const t = window.setTimeout(() => {
      void channel.current?.track({ userId: uid, name: latest.current.name, where: latest.current.where, since: since.current });
    }, 600);
    return () => window.clearTimeout(t);
  }, [whereKey, me.name, uid]);

  return others;
}
