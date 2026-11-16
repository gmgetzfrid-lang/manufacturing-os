import { useEffect, useMemo, useState } from "react";
import { Archive, Search } from "lucide-react";
import { api } from "../../lib/api";
import { Empty, Input, Pill } from "../../components/ui";
import { PageHeader, type Nav } from "../App";
import { ago, type Scan } from "../types";
import { ScanModal } from "./ScanModal";

export function FiledPage({ nav, tick }: { nav: Nav; tick: number }) {
  const [list, setList] = useState<Scan[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<Scan[]>("scans", { status: "filed", limit: 2000 }).then(setList).catch(() => setList([]));
  }, [tick]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list ?? []).filter((s) => !t || s.file_name.toLowerCase().includes(t) || s.equipment_rel.toLowerCase().includes(t));
  }, [list, q]);
  return (
    <>
      <PageHeader title="Filed" subtitle="Scans that were split and filed. Open one to see its documents, or take it back for correction." action={<div className="w-[320px]"><Input icon={<Search className="size-4" />} placeholder="Find by scan name or equipment" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1180px]">
          {list === null ? (
            <div className="card p-6"><div className="skeleton h-5 w-1/3" /></div>
          ) : shown.length === 0 ? (
            <div className="card"><Empty icon={<Archive className="size-6" />} title={list.length ? "No matches" : "Nothing filed yet"} /></div>
          ) : (
            <div className="card overflow-hidden">
              {shown.map((s) => (
                <button key={s.id} onClick={() => setOpen(s.id)} className="flex w-full items-center gap-4 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--color-surface-2)] cursor-pointer">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{s.equipment_rel.split("/").pop()}</div>
                    <div className="truncate text-[12px] text-[var(--color-text-muted)]">{s.equipment_rel.split("/").slice(0, -1).join(" › ")} · from {s.file_name}</div>
                  </div>
                  {s.new_folder && <Pill color="var(--color-info)">new folder</Pill>}
                  <div className="w-28 text-right text-[12.5px] tabular-nums text-[var(--color-text-muted)]">{s.documents} doc{s.documents === 1 ? "" : "s"} · {s.pages} p</div>
                  <div className="w-24 text-right text-[12px] text-[var(--color-text-faint)]">{ago(s.done_at)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {open !== null && <ScanModal id={open} onClose={() => setOpen(null)} nav={nav} />}
    </>
  );
}
