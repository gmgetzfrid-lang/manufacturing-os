"use client";

// components/thor/OpenerSetup.tsx — the two one-time setups behind opening
// THOR files, each spelled out so nothing looks like it happened by itself.
//
//   OpenerSetup  — the per-PC helper that lets "Open in program" launch a
//                  file from THOR in Excel, AutoCAD, Adobe… (lib/thor/opener.ts)
//   FolderSetup  — read access to the THOR folder for this browser, so PDFs
//                  and photos show right here (lib/thor/nasAccess.ts)

import React, { useState } from "react";
import { Check, Copy, Download, FolderOpen, HardDrive, X } from "lucide-react";
import { downloadText, installerCmd, uninstallerCmd, setOpenerInstalled } from "@/lib/thor/opener";

export default function OpenerSetup({ root, onDone, onClose, failed }: {
  root: string; onDone: () => void; onClose: () => void;
  /** Open was tried and nothing answered. */
  failed?: boolean;
}) {
  const [downloaded, setDownloaded] = useState(false);
  return (
    <div className="rounded-lg border border-teal-300 bg-teal-50 p-2.5 text-[11px] text-teal-950 space-y-1.5">
      <div className="flex items-start gap-1">
        <div className="font-bold flex-1 inline-flex items-center gap-1"><HardDrive className="w-3.5 h-3.5" /> {failed ? "Nothing opened — this PC needs the THOR opener" : "One-time setup: open THOR files in their own programs"}</div>
        <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div>A web page can&apos;t start Excel or AutoCAD by itself. This small helper (Windows, just for you, no admin) lets the app do it — the same as double-clicking the file in File Explorer. It only opens files inside <span className="font-mono">{root}</span> and never runs programs.</div>
      <ol className="list-decimal pl-4 space-y-1">
        <li>
          <button onClick={() => { downloadText("THOR-opener-setup.cmd", installerCmd(root)); setDownloaded(true); }}
            className="rounded-md bg-teal-700 text-white font-bold px-2 py-1 inline-flex items-center gap-1"><Download className="w-3 h-3" /> Download the setup file</button>
          <div className="mt-0.5 text-teal-900/80">If the browser says it &ldquo;can be harmful&rdquo;, choose <b>Keep</b>.</div>
        </li>
        <li>Open <b>THOR-opener-setup.cmd</b> from your Downloads. If Windows shows a blue warning, click <b>More info → Run anyway</b>. A black window says <b>OK</b> when it&apos;s done (or tells you if your IT blocks it).</li>
        <li>Come back here and click the button below. The browser then asks to open <b>Windows PowerShell</b> — tick <b>Always allow</b> and choose <b>Open</b>.</li>
      </ol>
      <div className="flex items-center gap-2 pt-0.5">
        <button disabled={!downloaded} onClick={() => { setOpenerInstalled(true); onDone(); }}
          title={downloaded ? undefined : "Download and run the setup file first"}
          className="rounded-md border border-teal-700 text-teal-900 font-bold px-2 py-1 inline-flex items-center gap-1 disabled:opacity-40">
          <Check className="w-3 h-3" /> The black window said OK — open the file
        </button>
        <button onClick={() => downloadText("THOR-opener-remove.cmd", uninstallerCmd())} className="text-teal-800 underline">Remove it later</button>
      </div>
    </div>
  );
}

/** Read access to the THOR folder, so PDFs and photos show here. */
export function FolderSetup({ root, onPick, onClose, error }: { root: string; onPick: () => void; onClose: () => void; error?: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50 p-2.5 text-[11px] text-sky-950 space-y-1.5">
      <div className="flex items-start gap-1">
        <div className="font-bold flex-1 inline-flex items-center gap-1"><FolderOpen className="w-3.5 h-3.5" /> One-time: let this browser read THOR</div>
        <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div>To show THOR PDFs and photos right here, the browser needs to be pointed at the THOR folder once. It can only read — nothing is changed or uploaded.</div>
      <ol className="list-decimal pl-4 space-y-1">
        <li>
          <button onClick={async () => { try { await navigator.clipboard.writeText(root); setCopied(true); } catch { /* shown below */ } }}
            className="rounded-md border border-sky-400 bg-white font-bold px-2 py-0.5 inline-flex items-center gap-1">
            {copied ? <Check className="w-3 h-3 text-green-700" /> : <Copy className="w-3 h-3" />} Copy <span className="font-mono">{root}</span>
          </button>
        </li>
        <li>Click <b>Choose the THOR folder</b>. A folder window opens (it may start in Documents — that&apos;s normal).</li>
        <li>Click in its <b>address bar at the top</b>, paste (Ctrl+V), press <b>Enter</b>, then click <b>Select Folder</b>.</li>
        <li>The browser asks to let this site view files — choose <b>View files</b> / <b>Allow</b>.</li>
      </ol>
      <button onClick={onPick} className="rounded-md bg-sky-700 text-white font-bold px-2 py-1 inline-flex items-center gap-1"><FolderOpen className="w-3 h-3" /> Choose the THOR folder</button>
      {error && <div className="text-amber-900">{error}</div>}
      <div className="text-sky-900/70">Works in Chrome and Edge. The browser remembers it; you may be asked to re-allow it after a restart.</div>
    </div>
  );
}
