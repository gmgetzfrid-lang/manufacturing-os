"use client";

// Modal — the single overlay shell. One backdrop recipe, one container
// recipe, one entrance, token-driven so it follows theme + dark mode.
// The app had 76 hand-rolled `fixed inset-0` shells with ~12 backdrop
// variants; new/retrofitted modals compose this instead:
//
//   <Modal onClose={close} size="lg">
//     <ModalHeader icon={Layers} title="Bulk edit" subtitle="12 documents" onClose={close} />
//     <ModalBody>…</ModalBody>
//     <ModalFooter>
//       <Button variant="secondary" onClick={close}>Cancel</Button>
//       <Button onClick={save}>Save</Button>
//     </ModalFooter>
//   </Modal>

import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
  full: "max-w-[min(96vw,1400px)]",
} as const;
export type ModalSize = keyof typeof SIZES;

export function Modal({
  onClose,
  size = "md",
  dismissable = true,
  zIndex = 400,
  className = "",
  children,
}: {
  onClose: () => void;
  size?: ModalSize;
  /** false = backdrop click / Escape don't close (mid-flight operations). */
  dismissable?: boolean;
  zIndex?: number;
  className?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissable, onClose]);

  // Modals are interaction-driven, so the document always exists by the
  // time one renders; the guard only protects an SSR edge case.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        className={`relative w-full ${SIZES[size]} max-h-[90vh] flex flex-col bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalHeader({
  icon: Icon,
  iconClassName = "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  title,
  subtitle,
  onClose,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /** Override for semantic tones, e.g. "bg-rose-50 text-rose-600". */
  iconClassName?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4 border-b border-[var(--color-border)] shrink-0">
      {Icon && (
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconClassName}`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-black truncate">{title}</h2>
        {subtitle && <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>}
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 -m-1 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function ModalBody({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`px-5 py-4 overflow-y-auto custom-scrollbar ${className}`}>{children}</div>;
}

export function ModalFooter({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-2xl shrink-0 ${className}`}
    >
      {children}
    </div>
  );
}

export default Modal;
