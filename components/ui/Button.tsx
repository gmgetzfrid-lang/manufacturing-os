"use client";

// Button — the single, token-driven button primitive. Variants map to the
// app's accent/surface tokens so it respects theming + org white-label, and
// has a real focus ring (the app was full of bespoke buttons with none).

import React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] border-transparent",
  secondary: "bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  ghost: "bg-transparent hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border-transparent",
  danger: "bg-rose-600 hover:bg-rose-500 text-white border-transparent",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
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
      className={`inline-flex items-center justify-center font-bold rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export default Button;
