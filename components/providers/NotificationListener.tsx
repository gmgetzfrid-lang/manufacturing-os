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

    return () => { supabase.removeChannel(channel); };
  }, [activeOrgId, userEmail, uid, showToast]);

  return null;
}
