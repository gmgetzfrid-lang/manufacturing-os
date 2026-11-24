"use client";

// Form controls: one token-driven recipe for text inputs, selects and
// textareas, and a Field wrapper: the label above (always visible; a
// placeholder is only an example), the control, then a hint or the error.
//
// Fields are 40 px tall (44 on touch screens) with 16 px text on a phone
// (no iPhone zoom); the resting edge is 3:1 against the page; focus is the
// app-wide 2 px ring with an offset, so the edge never jumps. Show an
// error after the person leaves the field, never while they type, and say
// how to fix it ("Enter a tag like P-2001").

import React from "react";
import { ChevronDown, CircleAlert } from "lucide-react";

export const controlClass =
  "w-full h-10 pointer-coarse:h-11 px-3 text-reading rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] aria-[invalid=true]:border-[var(--state-overdue)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} {...rest} className={`${controlClass} ${className}`} />;
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...rest }, ref) {
    return <textarea ref={ref} {...rest} className={`${controlClass} h-auto min-h-20 py-2 [field-sizing:content] ${className}`} />;
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <div className={`relative ${className}`}>
        <select ref={ref} {...rest} className={`${controlClass} appearance-none pr-8 cursor-pointer`}>
          {children}
        </select>
        <ChevronDown className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text-muted)]" />
      </div>
    );
  }
);

/** The line under a field that says what's wrong and how to fix it. */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <span id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-body font-medium text-[var(--state-overdue-text)]">
      <CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />
      <span>{children}</span>
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  className = "",
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** What's wrong and how to fix it; shown under the field (replaces the
   *  hint) and tied to the control with aria-describedby. */
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  // Tie the note to the control when the field holds a single element.
  const only = React.Children.count(children) === 1 && React.isValidElement(children) ? children as React.ReactElement<Record<string, unknown>> : null;
  const control = only && note
    ? React.cloneElement(only, {
        "aria-describedby": [only.props["aria-describedby"], noteId].filter(Boolean).join(" "),
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;
  return (
    <label className={`block ${className}`}>
      <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">
        {label}
      </span>
      {control}
      {error
        ? <FieldError id={noteId}>{error}</FieldError>
        : hint && <span id={noteId} className="block text-body text-[var(--color-text-muted)] mt-1.5">{hint}</span>}
    </label>
  );
}
