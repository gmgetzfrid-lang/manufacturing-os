import { useEffect, useState } from "react";
import { FileSpreadsheet, FolderOpen, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Field, Input, Section, Select, useToast } from "../../components/ui";
import { PageHeader } from "../App";
import type { IntakeState } from "../types";

export function SettingsPage({ state, refresh }: { state: IntakeState; refresh: () => void }) {
  const s = state.settings;
  const [root, setRoot] = useState(s.root);
  const [refs, setRefs] = useState<string[]>(s.references.length ? s.references : [""]);
  const [model, setModel] = useState(s.model);
  const [author, setAuthor] = useState(s.author);
  const [parallel, setParallel] = useState(String(s.parallel));
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    setRoot(s.root);
    setRefs(s.references.length ? s.references : [""]);
    setModel(s.model);
    setAuthor(s.author);
    setParallel(String(s.parallel));
  }, [s.root, s.references.join("|"), s.model, s.author, s.parallel]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (title: string): Promise<string | null> => {
    const r = await api<{ path: string | null }>("settings.pick_folder", { title });
    return r.path;
  };
  const save = async () => {
    setBusy("save");
    try {
      await api("settings.save", { root, references: refs.filter((r) => r.trim()), model, author, parallel: Number(parallel) });
      toast("ok", "Settings saved");
      refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const saveKey = async () => {
    setBusy("key");
    try {
      const r = await api<{ model: string }>("key.set", { key });
      setKey("");
      toast("ok", `Key works (${r.model}). Saved, encrypted for your Windows account.`);
      refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const dirty = root !== s.root || refs.filter((r) => r.trim()).join("|") !== s.references.join("|") || model !== s.model || author !== s.author || Number(parallel) !== s.parallel;
  return (
    <>
      <PageHeader title="Settings" action={<Button variant="primary" loading={busy === "save"} disabled={!dirty} onClick={save}>Save changes</Button>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[860px] space-y-5">
          <Section title="Folders" subtitle="Where scans arrive, and the existing network folders whose names are reused.">
            <div className="space-y-4">
              <Field label="Drop folder (scan drive)" hint="Scans saved here are picked up automatically. The organised unit folders, the indexes, _ORIGINAL SCANS and _INTAKE DATA are kept here too. Copy the unit folders (2000 - CRUDE UNIT, …) to the network when they are done.">
                <div className="flex gap-2">
                  <div className="flex-1"><Input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="E:\Digital Project" /></div>
                  <Button icon={<FolderOpen className="size-4" />} onClick={async () => { const p = await pick("Choose the drop folder"); if (p) setRoot(p); }}>Browse</Button>
                </div>
              </Field>
              <Field label="Network equipment folders (read only)" hint="The folder on the network drive that holds the unit folders (or one unit folder). Nothing there is ever changed: it is only read so that new files go into the folder that already exists, spelled exactly the same, and never clash with a file name already there.">
                <div className="space-y-2">
                  {refs.map((r, i) => (
                    <div key={i} className="flex gap-2">
                      <div className="flex-1"><Input value={r} onChange={(e) => setRefs(refs.map((x, k) => (k === i ? e.target.value : x)))} placeholder="\\thor\Engineering Dept\Equipment" /></div>
                      <Button icon={<FolderOpen className="size-4" />} onClick={async () => { const p = await pick("Choose the network equipment folder"); if (p) setRefs(refs.map((x, k) => (k === i ? p : x))); }}>Browse</Button>
                      <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setRefs(refs.length > 1 ? refs.filter((_, k) => k !== i) : [""])} aria-label="Remove" />
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setRefs([...refs, ""])}>Add another</Button>
                </div>
              </Field>
              <div className="flex items-center justify-between rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]">
                <span>{state.registry}</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => api("registry.refresh").then(() => toast("info", "Reading the folders again…"))}>Read folders again</Button>
              </div>
            </div>
          </Section>

          <Section title="Reading" subtitle="Pages are read with Claude by Anthropic, using your organisation's API key.">
            <div className="space-y-4">
              <Field label="API key" hint={s.key ? `Saved: ${s.key}. Paste a new key to replace it.` : "Create one at console.anthropic.com › Settings › API keys. It is checked, then stored encrypted for your Windows account only."}>
                <div className="flex gap-2">
                  <div className="flex-1"><Input type="password" icon={<KeyRound className="size-4" />} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.key ? "••••••••" : "sk-ant-…"} /></div>
                  <Button variant="primary" loading={busy === "key"} disabled={!key.trim()} onClick={saveKey}>Check and save</Button>
                  {s.key && <Button variant="ghost" onClick={() => confirm("Remove the saved key? Reading stops until a key is added again.") && api("key.clear").then(refresh)}>Remove</Button>}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Model" hint="Opus reads faded and handwritten pages best.">
                  <Select value={model} onChange={setModel} options={state.models.map((m) => ({ value: m.id, label: m.label }))} className="w-full" />
                </Field>
                <Field label="Scans read at the same time" hint="2 is a good balance; more is faster but uses the API harder.">
                  <Select value={parallel} onChange={setParallel} options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))} className="w-full" />
                </Field>
              </div>
            </div>
          </Section>

          <Section title="Filed documents" subtitle="What every filed PDF and index carries in its properties.">
            <div className="space-y-4">
              <Field label="Author / company" hint="Written as Author, Creator and Producer of every PDF and as the author of the Excel indexes.">
                <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button icon={<FileSpreadsheet className="size-4" />} onClick={async () => { const r = await api<{ failed: string[] }>("index.rebuild"); r.failed.length ? toast("warn", `Couldn't write ${r.failed.length} index file(s); close them in Excel and try again.`) : toast("ok", "Indexes rebuilt"); }}>Rebuild Excel indexes now</Button>
                <Button icon={<FolderOpen className="size-4" />} onClick={() => api("folder.open", { which: "originals" }).catch((e) => toast("error", e.message))}>Open original scans</Button>
              </div>
              {state.index_failed.length > 0 && <div className="text-[12.5px] text-[var(--color-warn)]">Waiting to update (open in Excel?): {state.index_failed.join(", ")}</div>}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
