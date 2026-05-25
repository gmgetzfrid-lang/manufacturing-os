"use client";

import React from "react";
import { Lock, Unlock, Users } from "lucide-react";
import type { DocumentRecord } from "@/types/schema";

interface CheckoutDotProps {
  docRecord: DocumentRecord;
  currentUserId?: string;
  onClick?: (doc: DocumentRecord) => void;
}

export default function CheckoutDot({ docRecord, currentUserId, onClick }: CheckoutDotProps) {
  const isLockedByMe = docRecord.checkedOutBy && docRecord.checkedOutBy === currentUserId;
  const isLockedByOther = docRecord.checkedOutBy && docRecord.checkedOutBy !== currentUserId;
  const hasCollaborators = (docRecord.activeCollaborators?.length ?? 0) > 0;

  // Determine state
  let color = "bg-emerald-500"; // available
  let ring = "ring-emerald-500/30";
  let glow = "shadow-emerald-500/40";
  let label = "Available";
  let Icon: typeof Unlock = Unlock;

  if (isLockedByMe) {
    color = "bg-blue-500";
    ring = "ring-blue-500/30";
    glow = "shadow-blue-500/40";
    label = "Checked out by you";
    Icon = Lock;
  } else if (isLockedByOther) {
    color = "bg-amber-500";
    ring = "ring-amber-500/30";
    glow = "shadow-amber-500/40";
    label = `Locked by ${docRecord.checkedOutByName || "another user"}`;
    Icon = Lock;
  } else if (hasCollaborators) {
    color = "bg-purple-500";
    ring = "ring-purple-500/30";
    glow = "shadow-purple-500/40";
    label = `${docRecord.activeCollaborators?.length} active`;
    Icon = Users;
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(docRecord); }}
      className="relative inline-flex items-center justify-center group/dot p-1"
      title={label}
    >
      <span className={`w-2.5 h-2.5 rounded-full ${color} ring-2 ${ring} shadow-md ${glow} transition-all group-hover/dot:scale-125`} />
      {/* Hover popover */}
      <span className="absolute left-1/2 -translate-x-1/2 top-full mt-2 px-2 py-1 bg-slate-900 text-white text-[10px] font-bold rounded-md whitespace-nowrap opacity-0 group-hover/dot:opacity-100 pointer-events-none transition-opacity duration-150 z-50 flex items-center gap-1 shadow-xl">
        <Icon className="w-2.5 h-2.5" />
        {label}
      </span>
    </button>
  );
}
