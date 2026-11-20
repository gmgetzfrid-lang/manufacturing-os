"use client";

// Button — the single, token-driven button primitive. Variants map to the
// app's accent/surface tokens so it respects theming + org white-label, and
// has a real focus ring (the app was full of bespoke buttons with none).

import React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

// Buttons always look like buttons: the main one is filled with the
// signal color, the rest are white with a ruled edge. Text-only is for
// links, never for buttons.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] border-transparent shadow-[0_1px_0_rgb(0_0_0/0.12)]",
  secondary: "bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)] hover:border-[var(--color-text-faint)]",
  ghost: "bg-transparent hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border-transparent",
  danger: "bg-[var(--state-overdue)] hover:brightness-95 text-white border-transparent",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-[15px] gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "primary", size = "md", loading, disabled, className = "", children, ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-semibold rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export default Button;
