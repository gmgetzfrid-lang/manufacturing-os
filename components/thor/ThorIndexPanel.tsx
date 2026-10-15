"use client";

// components/thor/ThorIndexPanel.tsx — what of THOR is indexed, and when.
//
// The share the index covers, its last crawl, and every folder the crawl
// walked with the time it was indexed and what it holds — browsable level by
// level (fetched as opened, never the whole tree at once). "Search here"
// narrows THOR results to a folder. Also where this browser is connected to
// THOR for opening originals read-only.

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, HardDrive, Loader2, Plug, Search, Trash2, AlertTriangle } from "lucide-react";
import { thorChildren, type ThorDirectory, type ThorOverview } from "@/lib/thor/client";
import { formatBytes } from "@/lib/thor/query";
import { fmtDate } from "./ThorResults";
import type { ThorOpener } from "./useThorOpener";

const ROLE_LABEL: Record<string, string> = {
  inspection: "inspection", drawings: "drawings", p_and_id: "P&ID", datasheets: "datasheets", calculations: "calculations",
  code_documents: "code docs", archive: "archive", equipment_folder: "equipment", equipment_category: "equipment type",
};

const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export default function ThorIndexPanel({ orgId, overview, opener, onSearchFolder }: {
  orgId: string; overview: ThorOverview | null; opener: ThorOpener; onSearchFolder: (rel: string) => void;
}) {
  const [connectErr, setConnectErr] = useState<string | null>(null);
  if (!overview) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] p-2 text-[11px] text-[var(--color-text-muted)]">
        <div className="font-bold text-[var(--color-text)] flex items-center gap-1"><HardDrive className="w-3.5 h-3.5 text-teal-700" /> THOR</div>
        No THOR index has been imported for this organisation. Apply migration 20261022 and run <code>scripts/thor_import.py</code>.
      </div>
    );
  }
  const root = overview.roots[0];
  const crawl = overview.crawls[0];
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-teal-300 bg-teal-50/50 p-2 text-xs space-y-1">
        <div className="font-bold flex items-center gap-1"><HardDrive className="w-3.5 h-3.5 text-teal-700" /> THOR · indexed share</div>
        <div className="font-mono text-[11px] break-all">{root?.unc_path}</div>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {overview.files.toLocaleString()} files · {overview.directories.toLocaleString()} folders
        </div>
        {crawl && (
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Last crawl {fmtTime(crawl.started_at)} → {fmtTime(crawl.completed_at)} · {crawl.status.replace(/_/g, " ")}{crawl.issues ? ` · ${crawl.issues} issues` : ""}
          </div>
        )}
        {root && <div className="text-[11px] text-[var(--color-text-muted)]">Imported into the app {fmtTime(root.imported_at)}{root.indexer_version ? ` · THOR Indexer ${root.indexer_version}` : ""}</div>}
        <div className="text-[10px] text-[var(--color-text-muted)]">Names, paths, sizes and dates only. The files stay on THOR.</div>
      </div>

      <div className="rounded-lg border border-[var(--color-border)] p-2 text-[11px] space-y-1">
        <div className="font-bold flex items-center gap-1"><Plug className="w-3.5 h-3.5" /> Open originals in this browser</div>
        {!opener.supported ? (
          <div className="text-amber-800">This browser can&apos;t read folders. Use Chrome or Edge; until then, copy a file&apos;s path and open it in File Explorer.</div>
        ) : opener.grants.length === 0 ? (
          <>
            <div className="text-[var(--color-text-muted)]">Pick <b>{opener.rootName}</b> on THOR once (read-only). After that, Open shows PDFs here straight from the share. Nothing is uploaded.</div>
            <button onClick={() => { setConnectErr(null); void opener.connect().catch((e) => setConnectErr((e as Error).message)); }}
              className="w-full inline-flex items-center justify-center gap-1 rounded-md bg-teal-700 text-white font-bold px-2 py-1">
              <Plug className="w-3.5 h-3.5" /> Connect THOR (read-only)
            </button>
          </>
        ) : (
          <ul className="space-y-0.5">
            {opener.grants.map((g) => (
              <li key={g.base} className="flex items-center gap-1">
                <FolderOpen className="w-3 h-3 text-teal-700" />
                <span className="flex-1 truncate" title={g.base || opener.rootName}>{g.base || opener.rootName}</span>
                <button onClick={() => void opener.forget(g.base)} title="Forget this folder in this browser" className="opacity-50 hover:opacity-100"><Trash2 className="w-3 h-3" /></button>
              </li>
            ))}
            <li><button onClick={() => { setConnectErr(null); void opener.connect().catch((e) => setConnectErr((e as Error).message)); }} className="font-semibold hover:underline">Connect another folder…</button></li>
          </ul>
        )}
        {connectErr && <div className="text-amber-800 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {connectErr}</div>}
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Indexed folders</div>
      <FolderLevel orgId={orgId} parent="" depth={0} onSearchFolder={onSearchFolder} />
    </div>
  );
}

function FolderLevel({ orgId, parent, depth, onSearchFolder }: { orgId: string; parent: string; depth: number; onSearchFolder: (rel: string) => void }) {
  const [rows, setRows] = useState<ThorDirectory[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    thorChildren(orgId, parent).then((r) => { if (live) setRows(r); }).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [orgId, parent]);
  if (err) return <div className="text-[11px] text-red-700">{err}</div>;
  if (!rows) return <div className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1" style={{ paddingLeft: depth * 12 }}><Loader2 className="w-3 h-3 animate-spin" /> …</div>;
  if (!rows.length) return null;
  return (
    <ul className="space-y-0.5">
      {rows.map((d) => <FolderRow key={d.rel_path} orgId={orgId} d={d} depth={depth} onSearchFolder={onSearchFolder} />)}
    </ul>
  );
}

function FolderRow({ orgId, d, depth, onSearchFolder }: { orgId: string; d: ThorDirectory; depth: number; onSearchFolder: (rel: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasKids = d.total_files > d.file_count || d.total_files === 0;
  return (
    <li>
      <div className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-[var(--color-canvas)] text-[11px]" style={{ paddingLeft: depth * 12 + 4 }}>
        <button onClick={() => setOpen((v) => !v)} className={`mt-0.5 shrink-0 ${hasKids ? "" : "invisible"}`}>
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <div className="flex-1 min-w-0">
          <button onClick={() => setOpen((v) => !v)} className="font-semibold truncate block max-w-full text-left" title={d.unc_path}>{d.name}</button>
          <div className="text-[10px] text-[var(--color-text-muted)]">
            {d.total_files.toLocaleString()} files · {formatBytes(d.total_bytes)} · indexed {fmtDate(d.indexed_at)}
            {d.crawl_state && d.crawl_state !== "completed" && <span className="text-amber-700"> · {d.crawl_state}</span>}
            {d.role && ROLE_LABEL[d.role] && <span> · {ROLE_LABEL[d.role]}</span>}
          </div>
        </div>
        <button onClick={() => onSearchFolder(d.rel_path)} title="List THOR files in this folder" className="opacity-0 group-hover:opacity-100 shrink-0 mt-0.5">
          <Search className="w-3.5 h-3.5 text-teal-700" />
        </button>
      </div>
      {open && <FolderLevel orgId={orgId} parent={d.rel_path} depth={depth + 1} onSearchFolder={onSearchFolder} />}
    </li>
  );
}
