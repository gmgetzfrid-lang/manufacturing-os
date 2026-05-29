"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useRole } from "./RoleContext";
import { useToast } from "./ToastProvider";

export function NotificationListener() {
  const { activeOrgId, userEmail, uid } = useRole();
  const { showToast } = useToast();
  const isFirstRun = useRef(true);
  const processedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeOrgId || !userEmail) return;

    isFirstRun.current = true;

    // Seed processed IDs from the latest messages on mount
    const seed = async () => {
      const { data } = await supabase
        .from("checkout_messages")
        .select("id")
        .eq("org_id", activeOrgId)
        .order("created_at", { ascending: false })
        .limit(5);

      if (data) {
        for (const row of data as { id: string }[]) {
          processedIds.current.add(row.id);
        }
      }
      isFirstRun.current = false;
    };

    seed();

    const channel = supabase
      .channel(`checkout-messages-${activeOrgId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "checkout_messages",
          filter: `org_id=eq.${activeOrgId}`,
        },
        (payload) => {
          if (isFirstRun.current) return;

          const data = payload.new as {
            id: string;
            user_id: string;
            user_name: string;
            text: string;
          };

          if (processedIds.current.has(data.id)) return;
          processedIds.current.add(data.id);

          const isSystem = data.user_id === "system";
          const isMe = !isSystem && data.user_id === uid;
          if (isMe) return;

          showToast({
            type: isSystem ? "info" : "warning",
            title: isSystem ? "System Alert" : `New Message from ${data.user_name}`,
            message: data.text || "New activity in document.",
            duration: 5000,
          });
        }
      )
      .subscribe();

    // Also fire toasts for new in-app notifications. Channel is
    // scoped to the recipient (uid) so we only see our own inbox
    // events, not the whole org's. Mentions / conflict events surface
    // as a toast so the user doesn't have to open the bell drawer.
    const seenNotifIds = new Set<string>();
    const notifChannel = !uid ? null : supabase
      .channel(`notifs-listener-${uid}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` },
        (payload) => {
          const row = payload.new as { id: string; kind: string; title: string; body: string | null };
          if (seenNotifIds.has(row.id)) return;
          seenNotifIds.add(row.id);
          // Tone the toast by kind for instant scannability.
          const isError = row.kind === "checkout_conflict" || row.kind === "hold_opened";
          const isMention = row.kind === "ticket_mention";
          showToast({
            type: isError ? "warning" : isMention ? "info" : "info",
            title: row.title,
            message: row.body ?? "",
            duration: 6000,
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (notifChannel) supabase.removeChannel(notifChannel);
    };
  }, [activeOrgId, userEmail, uid, showToast]);

  return null;
}
