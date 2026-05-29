// lib/presence.ts
//
// Thin wrapper around Supabase Realtime Presence so the rest of the
// app can mount "who else is here right now?" indicators on any
// resource without rewriting the channel-tracking ceremony.
//
// Each resource gets its own channel name, e.g. `presence:doc:<id>`.
// Tracked state: { userId, name, role, joinedAt }.

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export interface PresenceUser {
  userId: string;
  name: string;
  role?: string;
  joinedAt: string;
}

export type ResourceType = "document" | "project" | "asset";

interface UsePresenceParams {
  resourceType: ResourceType;
  resourceId: string | null | undefined;
  userId: string | null | undefined;
  userName?: string;
  role?: string;
}

/**
 * Returns the list of currently-present users on the given resource,
 * EXCLUDING the current user (so the indicator says "2 others viewing"
 * not "3 people viewing including you").
 */
export function usePresence({ resourceType, resourceId, userId, userName, role }: UsePresenceParams): PresenceUser[] {
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Stabilise the presence payload so React Strict Mode + dep-array
  // churn don't constantly re-subscribe.
  const payload = useMemo(() => ({
    userId,
    name: userName ?? userId ?? "Someone",
    role,
    joinedAt: new Date().toISOString(),
  }), [userId, userName, role]);

  useEffect(() => {
    if (!resourceId || !userId) return;
    const channelName = `presence:${resourceType}:${resourceId}`;
    const channel = supabase.channel(channelName, {
      config: { presence: { key: userId } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as Record<string, PresenceUser[]>;
        const flat: PresenceUser[] = [];
        for (const [key, list] of Object.entries(state)) {
          if (key === userId) continue;
          if (Array.isArray(list) && list.length > 0) {
            // The presence payload comes back as an array of "metas"
            // per key — usually one. Take the latest.
            flat.push(list[list.length - 1]);
          }
        }
        setOthers(flat);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track(payload);
        }
      });

    channelRef.current = channel;
    return () => {
      void channel.untrack();
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  // payload intentionally re-computed each mount; userId is stable
  // and is what gates the effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceType, resourceId, userId]);

  return others;
}
