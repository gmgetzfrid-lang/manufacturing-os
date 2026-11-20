"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { escapeStackBusy } from "@/components/documents/useEscapeClose";

interface InspectorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}

export default function InspectorDrawer({ isOpen, onClose, children, title }: InspectorDrawerProps) {
  // Close on Esc, unless a dialog is open over the drawer: that one closes
  // first, and a second Escape closes the drawer.
  const asideRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeStackBusy()) return;
      const above = Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== asideRef.current && !asideRef.current?.contains(el));
      if (above) return;
      onClose();
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
          // Same dim as every dialog (slate-900 at 50%).
          background: "rgba(15, 23, 42, 0.5)",
          backdropFilter: isOpen ? "blur(3px)" : "none",
          WebkitBackdropFilter: isOpen ? "blur(3px)" : "none",
        }}
        aria-hidden="true"
      />

      {/* Drawer panel — slides from right with spring easing */}
      <aside
        ref={asideRef}
        className={`fixed top-0 right-0 bottom-0 z-[60] w-[640px] max-w-[92vw] lg:w-[720px] bg-[var(--color-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col transition-transform duration-500 ${
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
        <div className="shrink-0 px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-2)]">
          <div className="text-xs font-black text-[var(--color-text-muted)] uppercase tracking-widest flex items-center gap-2 min-w-0 truncate">
            {title ?? "Inspector"}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            title="Close (Esc)"
            aria-label="Close"
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
