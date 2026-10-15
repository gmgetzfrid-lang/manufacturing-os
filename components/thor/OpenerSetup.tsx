"use client";

// components/thor/OpenerSetup.tsx — the one-time per-PC helper that lets Open
// launch THOR files in their own programs (lib/thor/opener.ts).

import React from "react";
import { Check, Download, HardDrive, X } from "lucide-react";
import { downloadText, installerCmd, uninstallerCmd, setOpenerInstalled } from "@/lib/thor/opener";

/** One-time setup so Open launches THOR files in their own programs. */
export default function OpenerSetup({ root, onDone, onClose }: { root: string; onDone: () => void; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-teal-300 bg-teal-50 p-2.5 text-[11px] text-teal-950 space-y-1.5">
      <div className="flex items-start gap-1">
        <div className="font-bold flex-1 inline-flex items-center gap-1"><HardDrive className="w-3.5 h-3.5" /> Open THOR files in their own programs</div>
        <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div>Browsers can&apos;t start programs by themselves. A one-time helper on this PC (Windows, per user, no admin) lets Open launch the file from THOR in Adobe, AutoCAD, Excel… — the same as double-clicking it in File Explorer. It only opens files inside <span className="font-mono">{root}</span>, and never runs programs.</div>
      <ol className="list-decimal pl-4 space-y-0.5">
        <li><button onClick={() => downloadText("THOR-opener-setup.cmd", installerCmd(root))} className="font-bold underline inline-flex items-center gap-1"><Download className="w-3 h-3" /> Download the setup file</button></li>
        <li>Open it from your downloads (if Windows warns, choose <b>More info → Run anyway</b>). It takes a second.</li>
        <li>Come back and click Open. The browser asks once — tick <b>Always allow</b>.</li>
      </ol>
      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={() => { setOpenerInstalled(true); onDone(); }} className="rounded-md bg-teal-700 text-white font-bold px-2 py-1 inline-flex items-center gap-1"><Check className="w-3 h-3" /> I&apos;ve run it — open the file</button>
        <button onClick={() => downloadText("THOR-opener-remove.cmd", uninstallerCmd())} className="text-teal-800 underline">Remove it later</button>
      </div>
    </div>
  );
}

