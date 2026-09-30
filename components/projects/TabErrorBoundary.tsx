"use client";

// TabErrorBoundary — projects-tab REL-5.
//
// The project page renders seven tabs inside one route, and the only error
// boundary was the segment's app/(protected)/error.tsx: a render exception
// in one tab (Costs, Quality, Schedule…) unmounted the header, the tab bar,
// the coach and the status controls with it, and "Try again" rebuilt the
// same crashing tab because the tab lives in the URL. This boundary wraps
// ONE tab's content: a throw renders "this tab couldn't load — retry" in
// its place and leaves the rest of the page — including every other tab —
// usable. `resetKey` (the tab name) clears the error when the user moves to
// another tab and back.

import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  /** What failed, as a noun phrase: "The Costs tab" → "The Costs tab couldn't load". */
  label: string;
  /** A change of this value clears a caught error (switching tabs). */
  resetKey?: string;
  children?: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class TabErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[TabErrorBoundary] ${this.props.label} crashed`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="rounded-2xl border border-rose-500/40 bg-rose-500/[0.06] p-6 text-center">
        <AlertTriangle className="w-6 h-6 mx-auto text-rose-600 mb-2" aria-hidden="true" />
        <div className="text-sm font-bold text-[var(--color-text)]">{this.props.label} couldn&apos;t load</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-1 break-words">
          {this.state.error.message || "Something went wrong while drawing it."} The rest of the project page still works.
        </div>
        <button
          type="button"
          onClick={this.retry}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
}
