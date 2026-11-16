import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, ExternalLink, FolderPlus, Merge, RotateCcw, Scissors, Archive } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Empty, Input, Modal, Pill, Select, Spinner, cx, useToast } from "../../components/ui";
import { PageHeader, type Nav } from "../App";
import { ago, money, previewName, type DocCall, type EquipEntry, type Filing, type IntakeState, type Scan, type ScanDetail } from "../types";

const RELATIONS = [
  { value: "same_equipment", label: "This equipment" },
  { value: "former_identity", label: "This equipment, under an older number/tag" },
  { value: "other_equipment_history", label: "Other equipment, part of this one's history" },
  { value: "unidentified", label: "No identifier on it" },
];

export function ReviewPage({ state, nav, tick }: { state: IntakeState; nav: Nav; tick: number }) {
  const [list, setList] = useState<Scan[] | null>(null);
  useEffect(() => {
    api<Scan[]>("scans", { status: "review", limit: 1000 }).then((l) => setList(l.reverse())).catch(() => setList([]));
  }, [tick]);
  const selected = Number(nav.params.id) || list?.[0]?.id || 0;
  return (
    <>
      <PageHeader title="Review" subtitle="Scans held because something wasn't certain. Check the split, names and folder, then file them. Nothing here has been filed yet." />
      <div className="flex min-h-0 flex-1">
        <div className="w-[300px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-2)]">
          {list === null ? (
            <div className="p-4"><div className="skeleton h-5" /></div>
          ) : list.length === 0 ? (
            <Empty icon={<ClipboardCheck className="size-6" />} title="Nothing to review">Everything read so far was filed automatically.</Empty>
          ) : (
            list.map((s) => (
              <button key={s.id} onClick={() => nav.go("review", { id: s.id })} className={cx("block w-full border-b border-[var(--color-border)] px-4 py-3 text-left cursor-pointer", s.id === selected ? "bg-[var(--color-surface)] shadow-[inset_3px_0_0_var(--color-accent)]" : "hover:bg-[var(--color-surface-3)]")}>
                <div className="truncate text-[13px] font-medium">{s.file_name}</div>
                <div className="mt-0.5 line-clamp-2 text-[12px] text-[var(--color-text-muted)]">{s.problems[0] ?? ""}</div>
                <div className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">{s.pages} pages · {ago(s.done_at)}</div>
              </button>
            ))
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? <Editor key={selected} id={selected} state={state} onDone={() => nav.go("review")} /> : null}
        </div>
      </div>
    </>
  );
}

function Editor({ id, state, onDone }: { id: number; state: IntakeState; onDone: () => void }) {
  const [d, setD] = useState<ScanDetail | null>(null);
  const [f, setF] = useState<Filing | null>(null);
  const [folderChoice, setFolderChoice] = useState<string>("");
  const [newRel, setNewRel] = useState<string | null>(null);
  const [lookup, setLookup] = useState<EquipEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const toast = useToast();
  useEffect(() => {
    api<ScanDetail>("scan", { id })
      .then((x) => {
        setD(x);
        const fl: Filing = x.filing ?? { equipment: { number: x.file_equipment ?? "", tag: "", description: "", existing_folder: "", confidence: "low", evidence: "", matches_file_name: "yes" }, documents: [], notes: "" };
        if (!fl.equipment.number && x.file_equipment) fl.equipment.number = x.file_equipment;
        if (fl.documents.length === 0 && x.pages.length) {
          fl.documents = [blankDoc(1, x.pages.length)];
        }
        setF(fl);
        const pick = x.candidates.find((c) => c.folder_name.toLowerCase() === fl.equipment.existing_folder.toLowerCase()) ?? (x.candidates.length === 1 ? x.candidates[0] : undefined);
        setFolderChoice(pick?.rel ?? "");
      })
      .catch((e) => toast("error", e.message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const number = f?.equipment.number ?? "";
  // Existing folders for the number as typed, and where a new one would go.
  useEffect(() => {
    if (!f) return;
    const t = setTimeout(() => {
      api<{ hits: EquipEntry[]; new_rel: string | null }>("registry.lookup", { q: number, tag: f.equipment.tag, description: f.equipment.description })
        .then((r) => {
          setLookup(r.hits);
          setNewRel(r.new_rel);
          if (r.hits.length === 1) setFolderChoice(r.hits[0].rel);
          else if (r.hits.length === 0) setFolderChoice("");
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [number, f?.equipment.tag, f?.equipment.description]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = d?.pages.length ?? 0;
  const coverage = useMemo(() => {
    if (!f || !d) return { missing: [] as number[], overlap: false };
    const own = new Array(total + 1).fill(0);
    f.documents.forEach((x) => { for (let p = x.first_page; p <= x.last_page && p <= total; p++) own[p]++; });
    const missing = d.pages.filter((p) => own[p.n] === 0 && !p.blank).map((p) => p.n);
    return { missing, overlap: own.some((c) => c > 1) };
  }, [f, d, total]);
  if (!d || !f) return <div className="flex items-center gap-2 p-8 text-[13px] text-[var(--color-text-muted)]"><Spinner /> Loading…</div>;
  const s = d.scan;
  const setDoc = (i: number, patch: Partial<DocCall>) => setF({ ...f, documents: f.documents.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const merge = (i: number) => {
    const a = f.documents[i], b = f.documents[i + 1];
    const docs = [...f.documents];
    docs.splice(i, 2, { ...a, last_page: b.last_page, drop_pages: [...a.drop_pages, ...b.drop_pages], doubts: "" });
    setF({ ...f, documents: docs });
  };
  const split = (i: number, at: number) => {
    const a = f.documents[i];
    if (at <= a.first_page || at > a.last_page) return;
    const docs = [...f.documents];
    docs.splice(i, 1, { ...a, last_page: at - 1, drop_pages: a.drop_pages.filter((p) => p < at) }, { ...blankDoc(at, a.last_page), folder: a.folder, drop_pages: a.drop_pages.filter((p) => p >= at) });
    setF({ ...f, documents: docs });
  };
  const equipOk = /^\s*\d{4}[.\-_ ]?\d{1,3}[A-Z]{0,2}\s*$/i.test(number) || /^\s*\d{5}\s*$/.test(number);
  const multiple = lookup.length > 1;
  const canFile = equipOk && !coverage.overlap && coverage.missing.length === 0 && f.documents.every((x) => x.title.trim() && x.folder) && (!multiple || !!folderChoice);
  const fileIt = async () => {
    setBusy(true);
    try {
      const fl = { ...f, equipment: { ...f.equipment, existing_folder: lookup.find((c) => c.rel === folderChoice)?.folder_name ?? "" } };
      await api("review.file", { id, filing: fl, equipment_rel: folderChoice });
      toast("ok", `Filed ${f.documents.length} document${f.documents.length === 1 ? "" : "s"}`);
      onDone();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (cmd: string, text: string) => {
    try {
      await api(cmd, { id });
      toast("ok", text);
      onDone();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const flagged = new Set(d.flagged);
  return (
    <div className="mx-auto max-w-[1100px] space-y-5 px-7 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold">{s.file_name}</div>
          <div className="text-[12.5px] text-[var(--color-text-muted)]">{total} pages · read for {money(s.cost)}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => api("scan.open_original", { id }).catch((e) => toast("error", e.message))}>Original</Button>
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => confirm("Read this scan again from scratch? It costs about the same as the first reading.") && act("scan.retry", "Queued to be read again")}>Read again</Button>
          <Button size="sm" icon={<Archive className="size-3.5" />} onClick={() => confirm("Set this scan aside without filing it? The original stays in _ORIGINAL SCANS.") && act("scan.set_aside", "Set aside")}>Set aside</Button>
        </div>
      </div>

      {s.problems.length > 0 && (
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,var(--color-surface))] px-4 py-3 text-[13px]">
          <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="size-4 text-[var(--color-warn)]" /> Why it was held</div>
          <ul className="ml-6 list-disc space-y-0.5 text-[var(--color-text-muted)]">{s.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      {/* Equipment */}
      <div className="card p-5">
        <div className="mb-3 text-[14px] font-semibold">Equipment</div>
        <div className="grid grid-cols-[180px_160px_1fr] gap-3">
          <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Equipment number</div>
            <Input value={f.equipment.number} placeholder="2010.06" onChange={(e) => setF({ ...f, equipment: { ...f.equipment, number: e.target.value } })} className={cx(!equipOk && "border-[var(--color-bad)]")} />
          </label>
          <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Tag (new folders)</div>
            <Input value={f.equipment.tag} placeholder="V-6" onChange={(e) => setF({ ...f, equipment: { ...f.equipment, tag: e.target.value } })} />
          </label>
          <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Description (new folders)</div>
            <Input value={f.equipment.description} placeholder="LIGHT NAPHTHA STABILIZER TOWER" onChange={(e) => setF({ ...f, equipment: { ...f.equipment, description: e.target.value } })} />
          </label>
        </div>
        {f.equipment.evidence && <div className="mt-2 text-[12px] text-[var(--color-text-faint)]">Read from: {f.equipment.evidence}</div>}
        <div className="mt-3 space-y-1.5 text-[13px]">
          {lookup.length > 0 ? (
            lookup.map((c) => (
              <label key={c.rel} className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer", folderChoice === c.rel ? "border-[var(--color-info)] bg-[color-mix(in_srgb,var(--color-info)_8%,var(--color-surface))]" : "border-[var(--color-border)]")}>
                <input type="radio" checked={folderChoice === c.rel} onChange={() => setFolderChoice(c.rel)} />
                <span className="min-w-0 flex-1 truncate">{c.rel.replaceAll("/", " › ")}</span>
                {c.oos && <Pill color="var(--color-text-muted)">out of service</Pill>}
                <Pill color={c.reference ? "var(--color-info)" : "var(--color-text-muted)"}>{c.reference ? "on network" : "on this drive"}</Pill>
              </label>
            ))
          ) : newRel ? (
            <div className="flex items-center gap-2 text-[var(--color-text-muted)]"><FolderPlus className="size-4 text-[var(--color-info)]" /> New folder: <span className="font-medium text-[var(--color-text)]">{newRel.replaceAll("/", " › ")}</span></div>
          ) : (
            <div className="text-[var(--color-bad)]">Enter a valid equipment number (e.g. 2010.06, 2015-001 or 55004).</div>
          )}
        </div>
      </div>

      {/* Documents */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[14px] font-semibold">Documents ({f.documents.length})</div>
          {(coverage.missing.length > 0 || coverage.overlap) && (
            <div className="text-[12.5px] text-[var(--color-bad)]">{coverage.overlap ? "Some pages are in two documents. " : ""}{coverage.missing.length ? `Pages not in any document: ${coverage.missing.join(", ")}` : ""}</div>
          )}
        </div>
        {f.documents.map((x, i) => (
          <DocCard key={i} i={i} x={x} id={id} total={total} equip={number.trim()} state={state} flagged={flagged.has(i)} last={i === f.documents.length - 1}
            onChange={(p) => setDoc(i, p)} onMerge={() => merge(i)} onSplit={(at) => split(i, at)} onPreview={setPreview} pages={d.pages} />
        ))}
      </div>

      <div className="sticky bottom-0 -mx-7 flex items-center justify-end gap-3 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-canvas)_92%,transparent)] px-7 py-3 backdrop-blur">
        {!canFile && <div className="mr-auto text-[12.5px] text-[var(--color-text-muted)]">Every page must be in a document, each document needs a title and folder, and the equipment folder must be chosen.</div>}
        <Button variant="primary" size="lg" loading={busy} disabled={!canFile} onClick={fileIt}>File {f.documents.length} document{f.documents.length === 1 ? "" : "s"}</Button>
      </div>
      {preview !== null && <PagePreview id={id} n={preview} total={total} onNav={setPreview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function blankDoc(a: number, b: number): DocCall {
  return { first_page: a, last_page: b, continues_previous_part: false, folder: "CORRESPONDENCE", title: "", date: "", date_basis: "", written_for_number: "", written_for_tag: "", relation: "same_equipment", drawing_number: "", revision: "", summary: "", drop_pages: [], confidence: "high", verdict: "confirmed", doubts: "" };
}

function DocCard({ i, x, id, total, equip, state, flagged, last, onChange, onMerge, onSplit, onPreview, pages }: {
  i: number; x: DocCall; id: number; total: number; equip: string; state: IntakeState; flagged: boolean; last: boolean;
  onChange: (p: Partial<DocCall>) => void; onMerge: () => void; onSplit: (at: number) => void; onPreview: (n: number) => void; pages: { n: number; blank: boolean }[];
}) {
  const nums: number[] = [];
  for (let p = x.first_page; p <= Math.min(x.last_page, total); p++) nums.push(p);
  const [splitAt, setSplitAt] = useState("");
  const dateOk = !x.date || /^\d{4}(-\d{2}(-\d{2})?)?$/.test(x.date.trim());
  return (
    <div className={cx("card overflow-hidden", flagged && "ring-2 ring-[color-mix(in_srgb,var(--color-warn)_55%,transparent)]")}>
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-[12.5px]">
        <span className="font-semibold">Document {i + 1}</span>
        <span className="text-[var(--color-text-muted)]">· pages</span>
        <input type="number" min={1} max={total} value={x.first_page} onChange={(e) => onChange({ first_page: Number(e.target.value) })} className="h-7 w-14 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-center" />
        <span>–</span>
        <input type="number" min={1} max={total} value={x.last_page} onChange={(e) => onChange({ last_page: Number(e.target.value) })} className="h-7 w-14 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-center" />
        {flagged && <Pill color="var(--color-warn)">check this one</Pill>}
        <div className="ml-auto flex items-center gap-1.5">
          {x.last_page > x.first_page && (
            <>
              <input placeholder="page" value={splitAt} onChange={(e) => setSplitAt(e.target.value)} className="h-7 w-14 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-center" />
              <Button size="sm" variant="ghost" icon={<Scissors className="size-3.5" />} onClick={() => { onSplit(Number(splitAt)); setSplitAt(""); }} title="Start a new document at this page">Split here</Button>
            </>
          )}
          {!last && <Button size="sm" variant="ghost" icon={<Merge className="size-3.5" />} onClick={onMerge}>Merge with next</Button>}
        </div>
      </div>
      {x.doubts && <div className="border-b border-[var(--color-border)] px-4 py-2 text-[12.5px] text-[var(--color-warn)]">{x.doubts}</div>}
      <div className="flex gap-2 overflow-x-auto px-4 pt-3">
        {nums.map((n) => {
          const dropped = x.drop_pages.includes(n) && pages[n - 1]?.blank;
          return (
            <button key={n} onClick={() => onPreview(n)} className={cx("relative shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-white cursor-zoom-in", dropped && "opacity-40")} title={dropped ? `Page ${n} (blank, left out)` : `Page ${n}`}>
              <img src={`/page/${id}/${n}`} loading="lazy" className="h-[118px] w-auto" alt={`Page ${n}`} />
              <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[10px] text-white">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-[200px_1fr_130px] gap-3 px-4 py-3">
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Folder</div>
          <Select value={x.folder} onChange={(v) => onChange({ folder: v })} options={state.folders.map((fo) => ({ value: fo.name, label: fo.name }))} className="w-full" />
        </label>
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Title (type first, then specifics)</div>
          <Input value={x.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="U-1A Manufacturer's Data Report" />
        </label>
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Date</div>
          <Input value={x.date} onChange={(e) => onChange({ date: e.target.value })} placeholder="YYYY-MM-DD" className={cx(!dateOk && "border-[var(--color-bad)]")} />
        </label>
      </div>
      <div className="grid grid-cols-[1fr_150px_120px] gap-3 px-4 pb-3">
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Belongs to</div>
          <Select value={x.relation} onChange={(v) => onChange({ relation: v })} options={RELATIONS} className="w-full" />
        </label>
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Written under no.</div>
          <Input value={x.written_for_number} onChange={(e) => onChange({ written_for_number: e.target.value })} placeholder="2010.15" />
        </label>
        <label className="block"><div className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Written under tag</div>
          <Input value={x.written_for_tag} onChange={(e) => onChange({ written_for_tag: e.target.value })} placeholder="V-15" />
        </label>
      </div>
      <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-[12.5px]">
        <span className="text-[var(--color-text-muted)]">{x.folder} › </span>
        <span className="font-medium">{previewName(equip, x)}</span>
      </div>
    </div>
  );
}

function PagePreview({ id, n, total, onNav, onClose }: { id: number; n: number; total: number; onNav: (n: number) => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && n < total) onNav(n + 1);
      if (e.key === "ArrowLeft" && n > 1) onNav(n - 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [n, total, onNav]);
  return (
    <Modal open onClose={onClose} width={980} title={`Page ${n} of ${total}`} subtitle="Use ← → to move between pages."
      footer={<><Button icon={<ChevronLeft className="size-4" />} disabled={n <= 1} onClick={() => onNav(n - 1)}>Previous</Button><Button disabled={n >= total} onClick={() => onNav(n + 1)}>Next <ChevronRight className="size-4" /></Button></>}>
      <img src={`/page/${id}/${n}`} className="mx-auto max-h-[72vh] w-auto rounded border border-[var(--color-border)] bg-white" alt={`Page ${n}`} />
    </Modal>
  );
}
