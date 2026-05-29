"use client";

// PresenceIndicator — stacked-avatar chip showing who else is on
// this resource right now. Backed by Supabase Realtime presence
// channels via lib/presence/usePresence.
//
// Mount it anywhere you'd like the SharePoint "3 people viewing"
// feeling. Today: document inspector, project header.

import React from "react";
import { Eye } from "lucide-react";
import { usePresence, type ResourceType } from "@/lib/presence";

interface Props {
  resourceType: ResourceType;
  resourceId: string | null | undefined;
  userId: string | null | undefined;
  userName?: string;
  role?: string;
  max?: number; // avatars to render; rest become +N pill
}

export default function PresenceIndicator({
  resourceType, resourceId, userId, userName, role, max = 3,
}: Props) {
  const others = usePresence({ resourceType, resourceId, userId, userName, role });
  if (others.length === 0) return null;
  const shown = others.slice(0, max);
  const extra = Math.max(0, others.length - max);
  return (
    <div
      className="inline-flex items-center gap-1.5"
      title={`${others.length} other${others.length === 1 ? "" : "s"} here: ${others.map((u) => u.name).join(", ")}`}
    >
      <Eye className="w-3 h-3 text-emerald-600" />
      <div className="flex -space-x-1.5">
        {shown.map((u) => (
          <div
            key={u.userId}
            className="w-5 h-5 rounded-full bg-gradient-to-tr from-emerald-500 to-emerald-600 text-[9px] font-black text-white flex items-center justify-center ring-2 ring-white shadow-sm"
            title={u.name}
          >
            {u.name.charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
      {extra > 0 && (
        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5">
          +{extra}
        </span>
      )}
    </div>
  );
}
