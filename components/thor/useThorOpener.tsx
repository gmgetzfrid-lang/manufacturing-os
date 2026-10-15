"use client";

// components/thor/useThorOpener.tsx — "Open" on a THOR result.
//
// Reads the original through the browser's read-only folder grant
// (lib/thor/nasAccess.ts). A PDF opens in the app's own viewer from a local
// blob URL; an image or text file is shown in place the same way. Anything
// else is not faked: the person gets the exact UNC path to open in File
// Explorer. No byte leaves the machine and nothing is written to THOR.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import { grantFolder, listGrants, forgetGrant, readThorFile, nasSupported, viewKind, NasError, type ThorGrant, type NasFailure } from "@/lib/thor/nasAccess";
import type { ThorFile } from "@/lib/thor/client";

export interface ThorViewing { url: string; title: string; file: ThorFile; kind: "pdf" | "image" | "text"; text?: string }
export interface ThorOpenProblem { file: ThorFile; reason: NasFailure | "unviewable" | "error"; message: string }

export function useThorOpener(orgId: string | null, rootUnc: string | null) {
  const [grants, setGrants] = useState<ThorGrant[]>([]);
  const [viewing, setViewing] = useState<ThorViewing | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<ThorOpenProblem | null>(null);
  const urls = useRef<string[]>([]);
  const rootName = rootUnc ? rootUnc.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : "Equipment Files";

  useEffect(() => { if (orgId) void listGrants(orgId).then(setGrants); }, [orgId]);
  // Local blob URLs are let go when the page goes.
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const knownFolder = useCallback(async (name: string) => {
    if (!orgId) return [];
    const { data } = await supabase.from("thor_directories").select("rel_path").eq("org_id", orgId).ilike("name", name.replace(/[%_]/g, "\\$&")).limit(20);
    const rels = ((data ?? []) as Array<{ rel_path: string }>).map((d) => d.rel_path);
    return Promise.all(rels.map(async (rel) => {
      const { data: kids } = await supabase.from("thor_directories").select("name").eq("org_id", orgId).eq("parent_rel", rel).limit(200);
      return { rel, children: ((kids ?? []) as Array<{ name: string }>).map((k) => k.name) };
    }));
  }, [orgId]);

  const connect = useCallback(async (): Promise<ThorGrant | null> => {
    if (!orgId) return null;
    try {
      const g = await grantFolder(orgId, rootName, knownFolder);
      setGrants(await listGrants(orgId));
      setProblem(null);
      return g;
    } catch (e) {
      if (e instanceof NasError && e.reason === "cancelled") return null;
      throw e;
    }
  }, [orgId, rootName, knownFolder]);

  const forget = useCallback(async (base: string) => {
    if (!orgId) return;
    await forgetGrant(orgId, base);
    setGrants(await listGrants(orgId));
  }, [orgId]);

  const read = useCallback(async (f: ThorFile, list: ThorGrant[]) => {
    const kind = viewKind(f.ext);
    if (kind === "none") {
      setProblem({ file: f, reason: "unviewable", message: `A .${f.ext || "?"} file can't be shown in the browser — use Open in program.` });
      return;
    }
    setOpening(f.file_id);
    try {
      const file = await readThorFile(list, f.rel_path);
      const url = URL.createObjectURL(file.type ? file : new Blob([file], { type: kind === "pdf" ? "application/pdf" : "" }));
      urls.current.push(url);
      setViewing({ url, title: f.filename, file: f, kind, text: kind === "text" ? (await file.slice(0, 2_000_000).text()) : undefined });
    } catch (e) {
      if (e instanceof NasError) setProblem({ file: f, reason: e.reason, message: e.message });
      else setProblem({ file: f, reason: "error", message: (e as Error).message });
    } finally { setOpening(null); }
  }, []);

  /** Show a PDF / image here. Without a folder grant yet, say so — the UI walks the person through it. */
  const open = useCallback(async (f: ThorFile) => {
    setProblem(null);
    if (!grants.length) {
      setProblem({ file: f, reason: "no-grant", message: "To show THOR files here, this browser needs read access to the THOR folder — once." });
      return;
    }
    await read(f, grants);
  }, [grants, read]);

  /** The folder picker, then straight on to the file that asked for it. */
  const connectAndOpen = useCallback(async (f: ThorFile) => {
    setProblem(null);
    try {
      const g = await connect();
      if (!g || !orgId) return;
      await read(f, await listGrants(orgId));
    } catch (e) {
      setProblem({ file: f, reason: e instanceof NasError ? e.reason : "error", message: (e as Error).message });
    }
  }, [connect, orgId, read]);

  const close = useCallback(() => setViewing(null), []);

  // Server render says "no"; the browser answers for itself (no hydration mismatch).
  const supported = useSyncExternalStore(noop, nasSupported, () => false);

  return { supported, grants, connect, connectAndOpen, forget, open, opening, viewing, close, problem, clearProblem: () => setProblem(null), rootName };
}

const noop = () => () => {};

export type ThorOpener = ReturnType<typeof useThorOpener>;

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}
