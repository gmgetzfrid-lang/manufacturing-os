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
      {/* Dim what's behind: the library stays in view, quieter. */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[55] transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{ background: "color-mix(in srgb, var(--color-ink) 58%, transparent)" }}
        aria-hidden="true"
      />

      {/* The panel: white, raised over the dimmed page, from the right. It
          starts under the top bar (the page frame keeps that bar on top). */}
      <aside
        ref={asideRef}
        className={`fixed top-14 right-0 bottom-0 sm:top-[64px] sm:right-3 sm:bottom-3 z-[60] w-full sm:w-[580px] lg:w-[640px] sm:max-w-[calc(100vw-24px)] bg-[var(--color-surface)] sm:rounded-xl sm:border sm:border-[var(--color-border)] flex flex-col overflow-hidden transition-transform duration-300 ease-out motion-reduce:transition-none ${
          isOpen ? "translate-x-0 ui-float" : "translate-x-[calc(100%+6rem)] pointer-events-none"
        }`}
        role="dialog"
        aria-modal={isOpen ? "true" : undefined}
        aria-hidden={!isOpen}
        aria-label={title ?? "Document"}
      >
        {/* Where you are, and the way out */}
        <div className="shrink-0 px-5 sm:px-7 pt-5 pb-1 flex items-center gap-3">
          <div className="flex-1 min-w-0 truncate text-body text-[var(--color-text-muted)]" title={title}>
            {title ?? "Document"}
          </div>
          <button
            onClick={onClose}
            className="ui-hit shrink-0 w-10 h-10 rounded-lg grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X className="w-4 h-4" strokeWidth={2.4} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 pt-2 pb-8 custom-scrollbar">{children}</div>
      </aside>
    </>
  );
}
