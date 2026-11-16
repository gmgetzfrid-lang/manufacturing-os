import { useEffect, useState } from "react";
import { ExternalLink, FileText, FolderOpen, RotateCcw, Undo2 } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Modal, Pill, Spinner, useToast } from "../../components/ui";
import type { Nav } from "../App";
import { STATUS, money, type ScanDetail } from "../types";

export function ScanModal({ id, onClose, nav }: { id: number; onClose: () => void; nav: Nav }) {
  const [d, setD] = useState<ScanDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = () => api<ScanDetail>("scan", { id }).then(setD).catch((e) => toast("error", e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (cmd: string, okText: string, after?: () => void) => {
    setBusy(true);
    try {
      await api(cmd, { id });
      toast("ok", okText);
      after ? after() : load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = d?.scan;
  return (
    <Modal open onClose={onClose} width={860} title={s ? s.file_name : "Scan"} subtitle={s ? `${STATUS[s.status].label}${s.pages ? ` · ${s.pages} pages` : ""}${s.cost ? ` · ${money(s.cost)}` : ""}` : undefined}
      footer={s && (
        <>
          <Button icon={<ExternalLink className="size-4" />} onClick={() => api("scan.open_original", { id }).catch((e) => toast("error", e.message))}>Open original scan</Button>
          {(s.status === "failed" || s.status === "set_aside" || s.status === "duplicate") && <Button loading={busy} icon={<RotateCcw className="size-4" />} onClick={() => act("scan.retry", "Queued to be read again")}>Read again</Button>}
          {s.status === "filed" && <Button loading={busy} icon={<Undo2 className="size-4" />} onClick={() => { if (confirm("Take this scan's documents back out of the folders and put it in Review for correction? The original scan is kept.")) act("scan.unfile", "Moved to Review", () => { onClose(); nav.go("review", { id }); }); }}>Take back for correction</Button>}
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      )}>
      {!d ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--color-text-muted)]"><Spinner /> Loading…</div>
      ) : (
        <div className="space-y-4 text-[13px]">
          {s!.error && <div className="rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_9%,var(--color-surface))] px-3 py-2 text-[var(--color-bad)]">{s!.error}</div>}
          {s!.stage && !s!.error && <div className="text-[var(--color-text-muted)]">{s!.stage}</div>}
          {s!.equipment_rel && (
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-text-muted)]">Folder:</span>
              <button className="truncate font-medium hover:underline cursor-pointer" onClick={() => api("folder.open", { which: "rel", rel: s!.equipment_rel }).catch((e) => toast("error", e.message))}>{s!.equipment_rel.replaceAll("/", " › ")}</button>
              {s!.new_folder && <Pill color="var(--color-info)">new folder</Pill>}
            </div>
          )}
          {d.documents.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
              {d.documents.map((doc) => (
                <div key={doc.id} className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-2.5 last:border-b-0">
                  <FileText className="size-4 shrink-0 text-[var(--color-text-faint)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{doc.file_rel.split("/").pop()}</div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">{doc.folder} · scan pages {doc.first_page}–{doc.last_page} · {doc.pages} page{doc.pages === 1 ? "" : "s"}{doc.summary ? ` · ${doc.summary}` : ""}</div>
                    {doc.note && <div className="text-[12px] text-[var(--color-warn)]">{doc.note}</div>}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => api("doc.open", { file_rel: doc.file_rel }).catch((e) => toast("error", e.message))}>Open</Button>
                  <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => api("doc.reveal", { file_rel: doc.file_rel }).catch((e) => toast("error", e.message))}>Show</Button>
                </div>
              ))}
            </div>
          )}
          {d.filing?.notes && <div className="text-[12.5px] text-[var(--color-text-muted)]">Notes: {d.filing.notes}</div>}
        </div>
      )}
    </Modal>
  );
}
