"use client";

// ProjectFilePlace - where this project's files go (the PSSR, turnover
// documents): the library and the folder, picked by the person and kept as
// the project's own. Asked before the first upload, never guessed: pick a
// library, pick a folder or make one right here, and change it any time.
// Files uploaded before a place was asked for are named, with a move when
// they are in the same library.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Folder, FolderPlus, Library as LibraryIcon, Loader2, MapPin, MoveRight } from "lucide-react";
import { createFolder, listLibraryFoldersOnce, type PickerFolder } from "@/lib/libraryCollections";
import {
  moveStraysHere, placeWords, projectFileHome, saveProjectFilePlace, strayProjectFiles,
  type ProjectFileHome, type StrayFile,
} from "@/lib/projectUpload";

/** The project's place for its files, kept fresh: `home` is null while it loads. */
export function useProjectFileHome(orgId: string, projectId: string): { home: ProjectFileHome | null; setHome: (h: ProjectFileHome) => void } {
  const [home, setHome] = useState<ProjectFileHome | null>(null);
  useEffect(() => {
    let live = true;
    void projectFileHome(orgId, projectId).then((h) => { if (live) setHome(h); }).catch(() => undefined);
    return () => { live = false; };
  }, [orgId, projectId]);
  return { home, setHome };
}

const btn = "min-h-9 py-1.5 text-left inline-flex items-center gap-1.5 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
const pri = "min-h-9 py-1.5 text-left inline-flex items-center gap-1.5 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black disabled:opacity-50";

export default function ProjectFilePlace({ orgId, projectId, uid, canManage, home, onChange, what = "files" }: {
  orgId: string; projectId: string; uid: string; canManage: boolean;
  home: ProjectFileHome | null; onChange: (h: ProjectFileHome) => void;
  /** What is being filed, for the wording ("files", "the PSSR"). */
  what?: string;
}) {
  const [open, setOpen] = useState(false);
  const [lib, setLib] = useState<string>("");
  const [folders, setFolders] = useState<PickerFolder[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<"folders" | "create" | "save" | "move" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [strays, setStrays] = useState<StrayFile[]>([]);
  const [moved, setMoved] = useState<number | null>(null);

  // Files this project's screens uploaded before a place was asked for.
  useEffect(() => {
    let live = true;
    if (!home?.place) { setStrays([]); return; }
    void strayProjectFiles(orgId, projectId, home).then((s) => { if (live) setStrays(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [orgId, projectId, home]);

  const loadFolders = useCallback(async (libraryId: string, pick?: string | null) => {
    setBusy("folders"); setErr(null); setFolders(null);
    try {
      const list = await listLibraryFoldersOnce(libraryId);
      // Tree order: each folder right under the one it is in.
      list.sort((a, b) => a.pathNames.join("\u0001").localeCompare(b.pathNames.join("\u0001"), undefined, { numeric: true }));
      setFolders(list);
      if (pick !== undefined) setFolder(pick);
    } catch (e) { setErr((e as Error).message); setFolders([]); }
    finally { setBusy(null); }
  }, []);

  const start = () => {
    setErr(null); setMoved(null); setOpen(true);
    setNewName(home?.name ?? "");
    const cur = home?.place ?? null;
    setLib(cur?.libraryId ?? "");
    setFolder(cur?.collectionId ?? null);
    if (cur?.libraryId) void loadFolders(cur.libraryId, cur.collectionId);
    else setFolders(null);
  };
  const pickLib = (id: string) => { setLib(id); setFolder(null); void loadFolders(id, null); };

  // The folder picked stays in sight in a long list (one just made, too).
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (!open || !folders) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, folders, folder]);

  const libName = home?.libraries.find((l) => l.id === lib)?.name ?? "";
  const picked = useMemo(() => (folder ? folders?.find((f) => f.id === folder) ?? null : null), [folder, folders]);
  const here = lib ? placeWords(libName, picked ? (picked.pathNames.length ? picked.pathNames : [picked.name]) : []) : "";

  const create = async () => {
    const name = newName.trim();
    if (!lib || !name) return;
    if (folders?.some((f) => (f.parentId ?? null) === (folder ?? null) && f.name.trim().toLowerCase() === name.toLowerCase())) { setErr(`There is already a folder named "${name}" there. Pick it from the list.`); return; }
    setBusy("create"); setErr(null);
    try {
      const id = await createFolder({ orgId, libraryId: lib, parentId: folder, name, createdBy: uid });
      setNewName("");
      await loadFolders(lib, id);
    } catch (e) { setErr(`The folder wasn't made: ${(e as Error).message}`); setBusy(null); }
  };

  const save = async () => {
    if (!lib) return;
    setBusy("save"); setErr(null);
    try {
      await saveProjectFilePlace(projectId, { libraryId: lib, collectionId: folder });
      onChange(await projectFileHome(orgId, projectId));
      setOpen(false);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const moveHere = async () => {
    if (!home) return;
    setBusy("move"); setErr(null);
    try {
      const n = await moveStraysHere(orgId, home, strays);
      setMoved(n);
      setStrays(await strayProjectFiles(orgId, projectId, home));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  if (!home) return null;
  const movable = strays.filter((s) => s.sameLibrary), stuck = strays.filter((s) => !s.sameLibrary);

  return (
    <div data-file-place className="space-y-2">
      {!open && (
        home.place ? (
          <div className="flex items-start gap-2 text-[12.5px]">
            <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 text-[var(--color-text-muted)]">Saved in <b className="text-[var(--color-text)] break-words">{home.words}</b></span>
            {canManage && <button type="button" onClick={start} className="shrink-0 font-bold text-[var(--color-accent)] hover:underline">Change</button>}
          </div>
        ) : (
          <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2.5 flex items-center gap-2 flex-wrap text-[12.5px] text-amber-900 dark:text-amber-200">
            <MapPin className="w-4 h-4 shrink-0" />
            <span className="min-w-0 flex-1 basis-48"><b>Pick where this project&rsquo;s {what === "files" ? "files" : `files (${what})`} go.</b> Asked once; nothing is filed until you choose.</span>
            {canManage ? <button type="button" onClick={start} className={pri}>Pick a place</button> : <span className="font-bold">The project&rsquo;s owner picks it.</span>}
          </div>
        )
      )}

      {open && (
        <div className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 space-y-3" data-file-place-picker>
          <div>
            <div className="text-[12px] font-semibold text-[var(--color-text-faint)] mb-1.5">1 · Library</div>
            <div className="flex flex-wrap gap-1.5">
              {home.libraries.map((l) => (
                <button key={l.id} type="button" aria-pressed={lib === l.id} onClick={() => pickLib(l.id)}
                  className={`h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border text-[12.5px] font-bold transition-colors ${lib === l.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                  <LibraryIcon className="w-3.5 h-3.5" /> {l.name}
                </button>
              ))}
              {home.libraries.length === 0 && <span className="text-[12.5px] text-[var(--color-text-muted)]">No libraries yet. Make one in Documents first.</span>}
            </div>
          </div>

          {lib && (
            <div>
              <div className="text-[12px] font-semibold text-[var(--color-text-faint)] mb-1.5">2 · Folder</div>
              {busy === "folders" || !folders ? <div className="text-[12.5px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the folders</div> : (
                <ul ref={listRef} className="max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]" role="listbox" aria-label="Folder">
                  <li>
                    <button type="button" role="option" aria-selected={folder === null} onClick={() => setFolder(null)}
                      className={`w-full flex items-center gap-2 px-2.5 py-2 text-left text-[12.5px] ${folder === null ? "bg-[var(--color-accent-soft)] font-bold" : "hover:bg-[var(--color-surface-2)]"}`}>
                      <LibraryIcon className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" /> <span className="flex-1">Top level of {libName}</span>
                      {folder === null && <Check className="w-3.5 h-3.5 text-[var(--color-accent)]" />}
                    </button>
                  </li>
                  {folders.map((f) => (
                    <li key={f.id}>
                      <button type="button" role="option" aria-selected={folder === f.id} onClick={() => setFolder(f.id)}
                        style={{ paddingLeft: `${10 + Math.max(0, f.pathNames.length - 1) * 16}px` }}
                        className={`w-full flex items-center gap-2 pr-2.5 py-2 text-left text-[12.5px] ${folder === f.id ? "bg-[var(--color-accent-soft)] font-bold" : "hover:bg-[var(--color-surface-2)]"}`}>
                        <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" /> <span className="flex-1 break-words">{f.name}</span>
                        {folder === f.id && <Check className="w-3.5 h-3.5 text-[var(--color-accent)]" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <FolderPlus className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
                <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
                  aria-label="New folder name" placeholder="New folder name"
                  className="h-9 flex-1 min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-base sm:text-[12.5px]" />
                <button type="button" onClick={() => void create()} disabled={!newName.trim() || busy !== null} className={btn}>
                  {busy === "create" ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5 shrink-0" />} Make folder {picked ? `in ${picked.name}` : "at the top"}
                </button>
              </div>
            </div>
          )}

          {err && <div className="text-[12.5px] font-bold text-rose-700 dark:text-rose-300">{err}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => void save()} disabled={!lib || !folders || busy !== null} className={pri}>
              {busy === "save" ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <Check className="w-4 h-4 shrink-0" />} {lib ? `Files go to ${here}` : "Pick a library"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={btn}>Cancel</button>
          </div>
        </div>
      )}

      {!open && err && <div className="text-[12.5px] font-bold text-rose-700 dark:text-rose-300">{err}</div>}
      {!open && moved != null && moved > 0 && <div className="text-[12.5px] font-bold text-emerald-700 dark:text-emerald-300">{moved} file{moved === 1 ? "" : "s"} moved to {home.words}.</div>}
      {!open && strays.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2 text-[12.5px] space-y-1.5" data-file-strays>
          <div className="font-bold text-[var(--color-text)]">{strays.length} file{strays.length === 1 ? "" : "s"} from this project {strays.length === 1 ? "is" : "are"} filed somewhere else</div>
          <ul className="space-y-0.5 text-[var(--color-text-muted)]">
            {strays.map((s) => <li key={s.id} className="break-words"><b className="text-[var(--color-text)]">{s.number}</b> in {s.libraryName}</li>)}
          </ul>
          {movable.length > 0 && canManage && (
            <button type="button" onClick={() => void moveHere()} disabled={busy !== null} className={btn}>
              {busy === "move" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoveRight className="w-3.5 h-3.5" />} Move {movable.length === 1 ? "it" : `${movable.length}`} here
            </button>
          )}
          {stuck.length > 0 && <div className="text-[var(--color-text-muted)]">{stuck.length === strays.length ? "A file" : `${stuck.length} of them`} can&rsquo;t be moved between libraries. Upload {stuck.length === 1 ? "it" : "them"} again here, then delete the old one in Documents.</div>}
        </div>
      )}
    </div>
  );
}
