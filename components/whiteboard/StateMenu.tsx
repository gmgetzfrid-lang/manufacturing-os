"use client";

// StateMenu — floating popover anchored at a screen position, lists
// every equipment state. Click a state → fires onPick. Click outside
// or ESC → closes.

import React, { useEffect, useRef } from "react";
import { ALL_STATES, STATE_LABEL, STATE_TONE, type EquipmentState } from "@/lib/whiteboard";

interface StateMenuProps {
  anchor: { x: number; y: number };
  current: EquipmentState;
  onPick: (s: EquipmentState) => void;
  onClose: () => void;
}

const TONE_DOT: Record<string, string> = {
  slate:   "bg-slate-400",
  blue:    "bg-blue-500",
  amber:   "bg-amber-500",
  emerald: "bg-emerald-500",
  red:     "bg-red-500",
};

export default function StateMenu({ anchor, current, onPick, onClose }: StateMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClickAway = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the click that opened us doesn't immediately close us.
    const handle = window.setTimeout(() => {
      window.addEventListener("mousedown", onClickAway);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Pin near the cursor but keep on-screen.
  const left = Math.min(window.innerWidth - 180, Math.max(8, anchor.x));
  const top = Math.min(window.innerHeight - 220, Math.max(8, anchor.y));

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left, top, zIndex: 300 }}
      className="bg-white border border-slate-200 rounded-lg shadow-xl py-1 min-w-[160px]"
      role="menu"
    >
      <div className="px-3 py-1.5 text-[9px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
        Set state
      </div>
      {ALL_STATES.map((s) => {
        const tone = STATE_TONE[s];
        const active = s === current;
        return (
          <button
            key={s}
            onClick={() => onPick(s)}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-slate-100 ${active ? "font-bold" : ""}`}
            role="menuitem"
          >
            <span className={`w-2.5 h-2.5 rounded-full ${TONE_DOT[tone]}`} />
            <span className="flex-1">{STATE_LABEL[s]}</span>
            {active && <span className="text-[10px] text-slate-500">current</span>}
          </button>
        );
      })}
    </div>
  );
}
