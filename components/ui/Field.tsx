"use client";

// Form controls — one token-driven recipe for text inputs, selects and
// textareas (the app had dozens of hand-rolled variants plus raw native
// selects), and a Field wrapper that renders the house label style.

import React from "react";
import { ChevronDown } from "lucide-react";

export const controlClass =
  "w-full h-9 px-3 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-[var(--color-accent-ring)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} {...rest} className={`${controlClass} ${className}`} />;
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...rest }, ref) {
    return <textarea ref={ref} {...rest} className={`${controlClass} h-auto min-h-20 py-2 ${className}`} />;
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <div className={`relative ${className}`}>
        <select ref={ref} {...rest} className={`${controlClass} appearance-none pr-8 cursor-pointer`}>
          {children}
        </select>
        <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text-faint)]" />
      </div>
    );
  }
);

export function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-[var(--color-text-faint)] mt-1">{hint}</span>}
    </label>
  );
}
