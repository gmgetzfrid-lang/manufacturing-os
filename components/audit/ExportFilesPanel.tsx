"use client";

// admin-and-org ALOG-11's hand-off (package P13): on /admin/audit, a
// DATA_EXPORT row that names a file record gets a "Files" control — the
// export's file list rebuilt from the audit trail by
// /api/admin/audit/export-files (lib/dataExport.ts rebuildExportList), with
// who took it shown as that user id's CURRENT member of the workspace (never
// the stored email) and the delivery said as the record allows: a recorded
// failure, or "No delivery failure recorded" — never "delivered".

import React, { useState } from "react";
import { supabase } from "@/lib/supabase";

interface FilesAnswer {
  recordId: string;
  exportedAt: string | null;
  exporter:
    | { kind: "machine"; label: string | null }
    | { kind: "member"; userId: string; email: string | null; role: string | null; status: string | null }
    | { kind: "former"; userId: string }
    | { kind: "unread"; userId: string; error: string };
  stored: { email: string | null; role: string | null };
  files: Array<{ path: string; documentId?: string | null; versionId?: string | null } | null>;
  delivery: { failureRecorded: true; error: string | null; at: string | null } | { failureRecorded: false };
}

/** The sentence naming who took the export (exported for the tests). */
export function exporterSentence(e: FilesAnswer["exporter"]): string {
  switch (e.kind) {
    case "machine": return "A scheduled push — no person took it (a machine row).";
    case "member": return `${e.email ?? e.userId}${e.role ? ` (${e.role})` : ""}${e.status && e.status !== "active" ? ` — ${e.status}` : ""}: this user id's current membership of the workspace, read now.`;
    case "former": return `A person no longer in this workspace (user id ${e.userId}).`;
    case "unread": return `User id ${e.userId} — their current membership could not be read (${e.error}).`;
  }
}

/** The sentence about delivery (exported for the tests). A null record is never "delivered". */
export function deliverySentence(d: FilesAnswer["delivery"]): string {
  return d.failureRecorded
    ? `Delivery failed${d.at ? ` (${new Date(d.at).toLocaleString()})` : ""}: ${d.error ?? "no reason recorded"}. The files below were carried, but nothing reached the other end.`
    : "No delivery failure recorded. (This is not proof of delivery: a delivery stopped mid-flight records nothing.)";
}

export default function ExportFilesPanel({ orgId, recordId }: { orgId: string; recordId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<FilesAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? "";
      const res = await fetch(`/api/admin/audit/export-files?orgId=${encodeURIComponent(orgId)}&recordId=${encodeURIComponent(recordId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { error?: string } | null)?.error || `HTTP ${res.status}`);
      setAnswer(body as FilesAnswer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !answer && !loading) void load();
  };

  const files = (answer?.files ?? []).filter((f): f is NonNullable<typeof f> => !!f);
  return (
    <div className="mt-1.5" data-testid="export-files-panel">
      <button type="button" onClick={toggle} className="text-[10px] font-bold text-blue-600 hover:underline">
        {open ? "Hide files" : "Files — who took which drawing"}
      </button>
      {open && (
        <div className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-[11px] text-[var(--color-text-muted)]">
          {loading && <div>Rebuilding the file list from the audit trail…</div>}
          {error && <div className="text-rose-700">The file list could not be rebuilt: {error}</div>}
          {answer && (
            <>
              <div><span className="font-bold text-[var(--color-text)]">Taken by:</span> {exporterSentence(answer.exporter)}</div>
              {answer.exporter.kind !== "machine" && (answer.stored.email || answer.stored.role) && (
                <div className="text-[10px] text-[var(--color-text-faint)]">Stored on the row: {answer.stored.email ?? "—"}{answer.stored.role ? ` (${answer.stored.role})` : ""}</div>
              )}
              <div className={answer.delivery.failureRecorded ? "text-rose-700 font-bold mt-1" : "mt-1"}>{deliverySentence(answer.delivery)}</div>
              <div className="mt-1 font-bold text-[var(--color-text)]">{files.length} file{files.length === 1 ? "" : "s"} in this export</div>
              <ul className="mt-0.5 max-h-48 overflow-y-auto font-mono text-[10px]">
                {files.map((f) => (
                  <li key={f.path} className="truncate">
                    {f.path}
                    {f.documentId ? <span className="text-[var(--color-text-faint)]"> · document {f.documentId.slice(0, 8)}</span> : null}
                    {f.versionId ? <span className="text-[var(--color-text-faint)]"> · revision {f.versionId.slice(0, 8)}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
