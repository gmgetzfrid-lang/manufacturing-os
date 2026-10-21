"use client";

// AttentionProvider — the tab's ONE attention feed (notifications Round G,
// N4 — RT-3 / TRAIL-8).
//
// Before it, every consumer of hooks/useTicketNotifications ran its own copy
// of the feed — the sidebar, the header bell and the (always mounted)
// notification center on every protected page, plus the dashboard's two
// widgets and /inbox — each with its own realtime channel and its own full
// refetch on every ticket change in the workspace. Mounted once in the
// protected layout, around the notification center (whose panel is a consumer
// too), this runs the feed once: one channel, one debounced fetch, one
// reconcile pass per tab. useTicketNotifications reads it from context with
// the same return shape as before, so no surface changed; useAttentionStatus
// reads how current and complete it is.
//
// The feed's machinery stays in hooks/useTicketNotifications.ts
// (useAttentionFeedState) — this file only owns where it is mounted.
//
// The badge trail's marks (notifications Round G, N11 TRAIL) ride a context
// of their own, so a page that reads only the marks (useAttentionRollup —
// the library explorer, /documents, /projects) re-renders when a mark
// changes, not on every feed pass.

import React from "react";
import { AttentionContext, AttentionRollupContext, useAttentionFeedState } from "@/hooks/useTicketNotifications";

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  const feed = useAttentionFeedState(true);
  return (
    <AttentionContext.Provider value={feed}>
      <AttentionRollupContext.Provider value={feed.rollup}>{children}</AttentionRollupContext.Provider>
    </AttentionContext.Provider>
  );
}

export default AttentionProvider;
