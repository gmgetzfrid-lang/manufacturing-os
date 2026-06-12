"use client";

// DialogProvider — async drop-in replacements for the browser's
// alert()/confirm()/prompt(), which the app used in ~90 places. The
// imperative API keeps call sites one-liners:
//
//   if (!(await appConfirm("Release this hold?"))) return;
//   const name = await appPrompt({ title: "Rename folder", defaultValue: cur });
//   await appAlert({ title: "Export failed", message: err.message, tone: "danger" });
//
// <DialogHost/> is mounted once in the protected layout. If a dialog is
// requested before the host mounts (or outside it), we fall back to the
// native dialog so callers never hang.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, HelpCircle, Info } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

type Tone = "default" | "danger";

interface BaseOpts {
  title?: string;
  message?: React.ReactNode;
  tone?: Tone;
  confirmLabel?: string;
  cancelLabel?: string;
}
export interface PromptOpts extends BaseOpts {
  placeholder?: string;
  defaultValue?: string;
}

type Request = { id: number } & (
  | (BaseOpts & { kind: "alert"; resolve: (v: void) => void })
  | (BaseOpts & { kind: "confirm"; resolve: (v: boolean) => void })
  | (PromptOpts & { kind: "prompt"; resolve: (v: string | null) => void })
);

let nextId = 1;

let enqueue: ((r: Request) => void) | null = null;

const norm = (o: string | BaseOpts): BaseOpts => (typeof o === "string" ? { message: o } : o);

export function appAlert(opts: string | BaseOpts): Promise<void> {
  const o = norm(opts);
  if (!enqueue) {
    window.alert([o.title, typeof o.message === "string" ? o.message : ""].filter(Boolean).join("\n"));
    return Promise.resolve();
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "alert", resolve }));
}

export function appConfirm(opts: string | BaseOpts): Promise<boolean> {
  const o = norm(opts);
  if (!enqueue) {
    return Promise.resolve(
      window.confirm([o.title, typeof o.message === "string" ? o.message : ""].filter(Boolean).join("\n"))
    );
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "confirm", resolve }));
}

export function appPrompt(opts: string | PromptOpts): Promise<string | null> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  if (!enqueue) {
    return Promise.resolve(window.prompt(typeof o.message === "string" ? o.message : o.title || "", o.defaultValue));
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "prompt", resolve }));
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0] ?? null;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);

  const settle = useCallback(
    (value: boolean | string | null) => {
      if (!current) return;
      if (current.kind === "alert") current.resolve();
      else if (current.kind === "confirm") current.resolve(value === true);
      else current.resolve(typeof value === "string" ? value : null);
      setQueue((q) => q.slice(1));
    },
    [current]
  );

  if (!current) return null;

  const danger = current.tone === "danger";
  const Icon = current.kind === "alert" ? (danger ? AlertTriangle : Info) : danger ? AlertTriangle : HelpCircle;
  const cancel = () => settle(current.kind === "confirm" ? false : null);

  return (
    <Modal onClose={cancel} size="sm" zIndex={700}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settle(current.kind === "prompt" ? (inputRef.current?.value ?? "") : true);
        }}
        className="p-5"
      >
        <div className="flex items-start gap-3">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
              danger ? "bg-rose-50 text-rose-600 dark:bg-rose-500/15" : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            }`}
          >
            <Icon className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            {current.title && <h2 className="text-sm font-black">{current.title}</h2>}
            {current.message && (
              <div className={`text-sm text-[var(--color-text-muted)] ${current.title ? "mt-1" : ""}`}>
                {current.message}
              </div>
            )}
            {current.kind === "prompt" && (
              <input
                key={current.id}
                ref={inputRef}
                autoFocus
                defaultValue={current.defaultValue}
                placeholder={current.placeholder}
                className="mt-3 w-full h-9 px-3 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
              />
            )}
          </div>
        </div>
        <ModalFooter className="-mx-5 -mb-5 mt-5">
          {current.kind !== "alert" && (
            <Button type="button" variant="secondary" onClick={cancel}>
              {current.cancelLabel ?? "Cancel"}
            </Button>
          )}
          <Button type="submit" variant={danger ? "danger" : "primary"} autoFocus={current.kind !== "prompt"}>
            {current.confirmLabel ?? (current.kind === "alert" ? "OK" : "Confirm")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
