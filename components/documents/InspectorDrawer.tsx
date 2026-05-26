"use client";

import React, { useEffect } from "react";
import { X } from "lucide-react";

interface InspectorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}

export default function InspectorDrawer({ isOpen, onClose, children, title }: InspectorDrawerProps) {
  // Close on Esc
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isOpen, onClose]);

  return (
    <>
      {/* Backdrop with frosted blur */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[55] transition-all duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{
          background: "rgba(15, 23, 42, 0.25)",
          backdropFilter: isOpen ? "blur(4px) saturate(140%)" : "none",
          WebkitBackdropFilter: isOpen ? "blur(4px) saturate(140%)" : "none",
        }}
        aria-hidden="true"
      />

      {/* Drawer panel — slides from right with spring easing */}
      <aside
        className={`fixed top-0 right-0 bottom-0 z-[60] w-[640px] max-w-[92vw] lg:w-[720px] bg-white shadow-2xl border-l border-slate-200/80 flex flex-col transition-transform duration-500 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
          boxShadow: "0 0 60px -10px rgba(0,0,0,0.15), 0 25px 50px -12px rgba(0,0,0,0.25)",
        }}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-slate-200/80 flex items-center justify-between bg-gradient-to-r from-slate-50 to-white">
          <div className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            {title ?? "Inspector"}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">{children}</div>
      </aside>
    </>
  );
}
