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

import React from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { X } from "lucide-react";

// Where the last press landed, so a dialog can grow out of the button that
// opened it (not fade in from nowhere).
let lastPress: { x: number; y: number; at: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => { lastPress = { x: e.clientX, y: e.clientY, at: Date.now() }; }, { capture: true, passive: true });
}

/** The point a dialog grows from: the press that opened it (within the
 *  last second), else the focused control outside the dialog, else none
 *  (it grows from its center). */
function triggerPoint(panel: HTMLElement): { x: number; y: number } | null {
  if (lastPress && Date.now() - lastPress.at < 1000) return { x: lastPress.x, y: lastPress.y };
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && !panel.contains(a)) {
    const r = a.getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

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
  labelledBy,
  label,
  children,
}: {
  onClose: () => void;
  size?: ModalSize;
  /** false = backdrop click / Escape don't close (mid-flight operations). */
  dismissable?: boolean;
  zIndex?: number;
  className?: string;
  /** The id of the dialog's title, or a label when it has none. */
  labelledBy?: string;
  label?: string;
  children: React.ReactNode;
}) {
  // Escape closes the dialog on top only: a dialog opened over another
  // closes first (one shared stack with every other dialog).
  useEscapeClose(onClose, dismissable);

  // Grow from the trigger: a short scale and fade (globals.css
  // .ui-float-in) whose origin is the button that opened the dialog.
  const panel = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const p = triggerPoint(el);
    if (!p) return;
    const r = el.getBoundingClientRect();
    el.style.transformOrigin = `${Math.round(p.x - r.left)}px ${Math.round(p.y - r.top)}px`;
  }, []);

  // Modals are interaction-driven, so the document always exists by the
  // time one renders; the guard only protects an SSR edge case.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
    >
      <div
        className="absolute inset-0 bg-[var(--color-ink)]/55 animate-in fade-in"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        ref={panel}
        className={`relative w-full ${SIZES[size]} max-h-[90vh] flex flex-col bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl ui-float ui-float-in ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalHeader({
  icon: Icon,
  iconClassName = "",
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
  // A plain icon at text size (no tile); a state color passed in
  // iconClassName (text-*) is kept, fills are dropped.
  const iconText = iconClassName.split(/\s+/).filter((c) => /^(?:dark:)?text-/.test(c)).join(" ") || "text-[var(--color-text-faint)]";
  return (
    <div className="flex items-start gap-2.5 px-5 py-4 border-b border-[var(--color-border)] shrink-0">
      {Icon && (
        <span aria-hidden className={`inline-flex shrink-0 mt-[3px] ${iconText}`}>
          <Icon className="w-5 h-5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-section leading-tight font-semibold truncate">{title}</h2>
        {subtitle && <p className="text-body text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>}
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close" title="Close"
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
      className={`flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-xl shrink-0 ${className}`}
    >
      {children}
    </div>
  );
}

export default Modal;
