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
//
// Focus (projects A11Y-4): while a modal is open, Tab and Shift+Tab cycle
// inside it — only the TOPMOST open modal traps, so a confirm opened from a
// dialog owns the keyboard until it closes. Opening moves focus into the
// dialog (an autoFocus inside it wins; otherwise the panel itself takes
// focus). Closing returns focus to the element that opened it — only when
// that element is still in the document, and only when focus has nowhere
// better to be (it was inside the dialog that just went away). Escape
// closes the topmost dismissable modal only (DEC-76 item 5), and never
// when something INSIDE its panel handled it first (an open HelpTooltip, an
// editor) — a key handled by a page-level handler outside the panel (an
// overlay under a confirm) cannot stop the confirm cancelling. The keys are
// read on `document`, after a control's own handler and before any
// page-level `window` handler. A Tab a control already handled (a textarea
// that inserts a mention) is left alone, and so is a Tab while focus sits in
// an overlay the modal does not own (another dialog, a portaled listbox or
// menu above it). A closed modal is unmounted, so nothing ever traps for a
// modal that is not on screen. ModalHeader's title names the dialog
// (aria-labelledby).

import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDockAvoid } from "@/components/ui/CornerDock";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
  full: "max-w-[min(96vw,1400px)]",
} as const;
export type ModalSize = keyof typeof SIZES;

/** Open modals, innermost last. Only the last one traps focus and answers
 *  Escape. Module-level: every Modal on the page shares it. */
const openModals: string[] = [];
const isTopmost = (id: string) => openModals[openModals.length - 1] === id;

const FOCUSABLE = [
  "a[href]", "area[href]", "button:not([disabled])", "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])", "textarea:not([disabled])", "iframe", "summary",
  "[contenteditable=\"true\"]", "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => el.tabIndex >= 0 && !el.closest("[inert], [hidden]"));
}

/** An overlay root a Modal does not own: focus inside one belongs to that
 *  overlay (another dialog, a portaled listbox or menu opened above). */
const FOREIGN_OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="listbox"], [role="menu"], [data-overlay]';

/** Focus the first element of `list` that actually takes focus (one that is
 *  not rendered — display:none — refuses it in a browser). */
function focusFirstOf(list: HTMLElement[]): boolean {
  for (const el of list) {
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return true;
  }
  return false;
}

const ModalTitleContext = createContext<string | null>(null);

export function Modal({
  onClose,
  size = "md",
  dismissable = true,
  zIndex = 400,
  className = "",
  ariaLabel,
  ariaLabelledBy,
  children,
}: {
  onClose: () => void;
  size?: ModalSize;
  /** false = backdrop click / Escape don't close (mid-flight operations). */
  dismissable?: boolean;
  zIndex?: number;
  className?: string;
  /** The dialog's accessible name, when no ModalHeader / labelled title names it. */
  ariaLabel?: string;
  /** Id of the element that names the dialog (a ModalHeader names it by itself). */
  ariaLabelledBy?: string;
  children: React.ReactNode;
}) {
  const modalId = useId();
  const titleId = `${modalId}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The opener is read while rendering — before an autoFocus inside the
  // dialog moves focus in during the commit.
  const [opener] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));

  // Open: join the stack, move focus in. Close: leave the stack, hand focus
  // back to the opener when it still exists.
  useEffect(() => {
    const dialog = dialogRef.current;
    const panel = panelRef.current;
    openModals.push(modalId);
    if (dialog && !ariaLabel && !ariaLabelledBy && document.getElementById(titleId)) {
      dialog.setAttribute("aria-labelledby", titleId);
    }
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      const at = openModals.lastIndexOf(modalId);
      if (at >= 0) openModals.splice(at, 1);
      // StrictMode rehearses an unmount with the DOM still in place — not a close.
      if (dialog?.isConnected) return;
      const active = document.activeElement;
      const focusLost = !active || active === document.body || (dialog?.contains(active) ?? false);
      if (!focusLost) return;
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [modalId, titleId, opener, ariaLabel, ariaLabelledBy]);

  // Keyboard: Escape closes the topmost dismissable modal; Tab cycles inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTopmost(modalId)) return;
      const panel = panelRef.current;
      if (e.key === "Escape") {
        // Handled already by something inside this panel (a tooltip, an
        // editor): theirs. Handled only outside it: still ours to cancel.
        const handledInside = e.defaultPrevented && !!panel && e.target instanceof Node && panel.contains(e.target);
        if (dismissable && !handledInside) onClose();
        return;
      }
      if (e.key !== "Tab" || e.defaultPrevented) return;
      if (!panel) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && active !== panel && panel.contains(active);
      // Focus in an overlay this modal does not own (one opened above it):
      // that overlay's Tab, not ours.
      if (!inside && active) {
        const foreign = active.closest(FOREIGN_OVERLAY);
        if (foreign && !dialogRef.current?.contains(foreign)) return;
      }
      const list = focusables(panel);
      if (list.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      if (!inside) {
        e.preventDefault();
        focusFirstOf(e.shiftKey ? [...list].reverse() : list);
        return;
      }
      // Only the edges are ours; between them the browser moves focus.
      const after = list.filter((el) => active!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const before = list.filter((el) => active!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
      if (!e.shiftKey && after.length === 0) { e.preventDefault(); focusFirstOf(list); }
      else if (e.shiftKey && before.length === 0) { e.preventDefault(); focusFirstOf([...list].reverse()); }
    };
    // On `document`: after a control's own (React) handler inside the panel,
    // before any page-level `window` handler.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalId, dismissable, onClose]);

  // Modals are interaction-driven, so the document always exists by the
  // time one renders; the guard only protects an SSR edge case.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-[3px] animate-in fade-in"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative w-full ${SIZES[size]} max-h-[90vh] flex flex-col bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 ease-spring outline-none ${className}`}
      >
        <ModalTitleContext.Provider value={titleId}>{children}</ModalTitleContext.Provider>
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
  const titleId = useContext(ModalTitleContext);
  return (
    <div className="flex items-start gap-3 px-5 py-4 border-b border-[var(--color-border)] shrink-0">
      {Icon && (
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${iconClassName}`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2 id={titleId ?? undefined} className="text-sm font-black truncate">{title}</h2>
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
  // The corner dock sits above every modal; it keeps clear of this action
  // row so a toast or an upload card never sits on its buttons (STACK-10).
  const ref = useRef<HTMLDivElement>(null);
  useDockAvoid(ref, true);
  return (
    <div
      ref={ref}
      className={`flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-2xl shrink-0 ${className}`}
    >
      {children}
    </div>
  );
}

export default Modal;
