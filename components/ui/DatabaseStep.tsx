"use client";

// DatabaseStep - a screen that needs a database update a person has to run.
// It hands over the exact SQL (Copy, or select it from the box), opens the
// SQL Editor of the Supabase project this app uses, and checks again. Nothing
// is run from here.

import React, { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { sqlEditorUrl, supabaseProjectRef } from "@/lib/setupSql";

export default function DatabaseStep({ title, why, sql, onCheck }: { title: string; why: string; sql: string; onCheck: () => void }) {
  const [copied, setCopied] = useState<"yes" | "select" | null>(null);
  const ref = supabaseProjectRef();
  const copy = async () => {
    try { await navigator.clipboard.writeText(sql); setCopied("yes"); }
    catch {
      const box = document.getElementById("database-step-sql") as HTMLTextAreaElement | null;
      box?.focus(); box?.select(); setCopied("select");
    }
  };
  const btn = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-bold";
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-4 text-[13px] text-amber-900 dark:text-amber-200 space-y-3" data-database-step>
      <div>
        <b className="block text-[14px]">{title}</b>
        <p>{why}</p>
      </div>
      <ol className="list-decimal pl-5 space-y-1">
        <li>Copy the SQL.</li>
        <li>Open the SQL Editor{ref ? <> of project <b className="font-mono">{ref}</b></> : ""}, paste it, and press Run. It should say &ldquo;Success. No rows returned&rdquo;.</li>
        <li>Come back and press Check again.</li>
      </ol>
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={() => void copy()} className={`${btn} bg-amber-900 text-amber-50 dark:bg-amber-200 dark:text-amber-950`}>{copied === "yes" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}{copied === "yes" ? "Copied" : "Copy the SQL"}</button>
        <a href={sqlEditorUrl(ref)} target="_blank" rel="noreferrer" className={`${btn} border border-amber-400 dark:border-amber-700`}><ExternalLink className="w-4 h-4" /> Open the SQL Editor</a>
        <button type="button" onClick={onCheck} className={`${btn} border border-amber-400 dark:border-amber-700`}><RefreshCw className="w-4 h-4" /> Check again</button>
      </div>
      {copied === "select" && <p>Copy didn&rsquo;t work in this browser. The SQL below is selected: press Ctrl+C (or Cmd+C).</p>}
      <details>
        <summary className="cursor-pointer font-bold">Show the SQL</summary>
        <textarea id="database-step-sql" readOnly value={sql} rows={12} className="mt-2 w-full rounded-lg border border-amber-300 dark:border-amber-800 bg-white/70 dark:bg-black/20 p-2 font-mono text-[11.5px] text-[var(--color-text)]" />
      </details>
      <p className="text-[12px] opacity-80">If Run shows an error instead, send it over.</p>
    </div>
  );
}
