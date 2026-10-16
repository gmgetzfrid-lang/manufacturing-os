import { useEffect, useState, type ReactNode } from "react";
import { Ban, Check, Cpu, Eye, FileLock2, FolderLock, Globe, KeyRound, ListChecks, Lock, Package, Settings2, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Mark, Pill } from "../components/ui";

interface About {
  version: string; me: string; local_data: string; temp: string; team: AppState["team"]; default_team: string;
  groups: { open: number; locked: number; hidden: number; unavailable: number };
  protected_roots: string[]; writable: string[]; ai_hosts: string[]; ai_blocked_by_it: boolean; policy_key: string;
  exe?: string; exe_sha256?: string | null; machine: string; index: { source: string };
}

export function AboutPage({ state }: { state: AppState }) {
  const [a, setA] = useState<About | null>(null);
  useEffect(() => { api<About>("about").then(setA); }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 py-8">
        <div className="flex items-center gap-4">
          <Mark size={60} />
          <div>
            <div className="text-[24px] font-[800] tracking-[0.18em]">TRACEPOINT</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">Version {state.version} · THOR document search and equipment graph</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[color-mix(in_srgb,var(--color-ok)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-ok)_6%,transparent)] p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="size-5 text-[var(--color-ok)]" /> For IT: the short version</div>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
            {[
              "People only see THOR files their own Windows account can open. No exceptions, no override — see below.",
              "Sign-in is the Windows account. TracePoint has no passwords and no user database.",
              "Never writes, renames, moves or deletes anything on THOR, and never changes a THOR permission.",
              "One portable .exe. No installer, admin rights, services, drivers or scheduled tasks. Contains no THOR data.",
              "No telemetry, auto-update or licence server. Only network use: THOR (SMB), plus optional AI for administrators.",
              "AI is off unless an administrator sets it up, capped at a monthly budget, and IT can block it per PC.",
            ].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />{t}</li>)}
          </ul>
        </div>

        <section className="mt-6 card p-5">
          <div className="flex items-center gap-2 text-[16px] font-bold"><span className="flex size-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><Lock className="size-4" /></span>Who sees what: Windows permissions decide</div>
          <p className="mt-2 text-[14px] leading-relaxed">Someone who can't open <span className="font-mono text-[13px]">\\thor\Equipment Files</span> in Windows never sees a single file name, folder name, equipment number or word of document text from it in TracePoint — not in search, the equipment list, the graph, exports, or the files TracePoint keeps on their PC.</p>
          <div className="mt-4 grid grid-cols-4 gap-3">
            {[
              ["1", "Scan", "An administrator's scan records, for every file, which Windows accounts and groups may open it. Read-only."],
              ["2", "Split and lock", "Files with the same permissions form a group. Each group's names and text go in its own folder in the shared TracePoint folder, locked with those same permissions — read back and checked. If the file server doesn't keep them exactly, that group isn't shared with anyone."],
              ["3", "Windows opens", "Each PC loads only the groups Windows lets that person open. The file server decides; TracePoint can't override it, and neither can another program."],
              ["4", "Double-check", "Before showing a group, the PC asks Windows whether this person can open a few of its THOR files (open and close; nothing read). Any \"no\" hides the whole group."],
            ].map(([n, t, d]) => (
              <div key={n} className="rounded-xl bg-[var(--color-surface-2)] p-3.5">
                <div className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-full bg-[var(--color-accent)] text-[12px] font-bold text-white">{n}</span><span className="text-[14px] font-semibold">{t}</span></div>
                <div className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{d}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 divide-y divide-[var(--color-border)]">
            <Row k="The rule" v="A file is shown only if the person may open it — stricter than Explorer, which lists file names in any folder you can browse. Its folder names come with it; folders with nothing you may open never appear." />
            <Row k="Group changes" v="Adding or removing someone from a Windows group applies straight away: the shared index files are locked with the same groups." />
            <Row k="Permission edits" v="A permission changed directly on a THOR folder applies at the next rescan (administrators can rescan any time). Until then, step 4 hides a group as soon as Windows refuses one of the files it checks." />
            <Row k="Share permissions" v="Folder (NTFS) permissions are copied. If a THOR share is restricted only by share-level permissions, step 4 still hides it on every PC; Sources flags groups open to all staff so IT can confirm, or set the same restriction on the folder." />
            <Row k="Left out" v="Files whose permissions can't be read, or whose rules TracePoint can't reproduce exactly (for example a conditional deny), are not shared at all." />
            <Row k="Security logs" v="Step 4's checks are ordinary read-only opens. If THOR audits failed access, a person's start-up can log a few denied opens (at most five per group) for folders they can't open." />
            {a && a.team.mode === "team" && <Row k="On this PC" v={`${a.groups.open} group(s) loaded for ${a.me}${a.groups.locked ? `; ${a.groups.locked} locked to this account` : ""}${a.groups.hidden ? `; ${a.groups.hidden} hidden by step 4` : ""}.`} />}
          </div>
        </section>

        <Block icon={<KeyRound className="size-4" />} title="Accounts and roles">
          <Row k="Sign-in" v={`Windows account of whoever started TracePoint (now: ${a?.me ?? "…"}). No TracePoint passwords, no default password, no lockouts.`} />
          <Row k="Roles" v="Administrator and Indexer are given to Windows accounts in roles.json in the shared folder; everyone else is a User. TracePoint sets the shared folder's permissions to match: administrators full control, indexers modify, all signed-in staff read only — so only they can change roles or publish an index." />
          <Row k="AI keys" v="Administrators only. Each key is encrypted by Windows for that account on that PC (DPAPI) and kept in the local data folder — never on the shared folder." />
          <Row k="Activity log" v="Scans, sharing, role and setting changes and AI use, with account and computer, in the shared folder's admin\ subfolder (administrators and indexers only). Searches are never logged." />
        </Block>

        <Block icon={<Settings2 className="size-4" />} title="IT policy (Group Policy or registry)">
          <Row k="Key" v={a?.policy_key ?? "HKLM\\SOFTWARE\\Policies\\TracePoint"} mono note="Also read from HKCU. Nothing else in the registry is read or written." />
          <Row k="DisableAI" v={`DWORD 1 = no AI requests from this PC, whoever is signed in.${a ? ` Now: ${a.ai_blocked_by_it ? "blocked" : "not set"}.` : ""}`} />
          <Row k="TeamFolder" v={`String = the shared TracePoint folder for this PC; users can't change it. Without it, TracePoint looks next to the exe, then at ${a?.default_team ?? "\\\\thor\\Public\\TP\\TracePoint Data"}.`} />
        </Block>

        <Block icon={<Eye className="size-4" />} title="What it reads">
          <Row k="THOR files" v="Read-only, as the signed-in Windows user: when someone previews or opens a file; when an administrator or indexer scans (folder listings, names, sizes, dates, permissions); when document contents are read for search (each file read into memory, text kept, file released)." note="Scans and content reading run at below-normal priority with a bounded number of parallel reads." />
          <Row k="Index" v={a?.index.source ?? "…"} />
          <Row k="Protected sources" v={a ? a.protected_roots.join(" · ") || "—" : "…"} mono />
        </Block>

        <Block icon={<FolderLock className="size-4" />} title="What it writes — and the only places it can">
          <Row k="Shared folder" v={a?.team.folder ?? "Not used on this PC"} mono note="tracepoint.json, roles.json, index\ (one locked folder per permission group), admin\ (activity log, AI ledger, scan lock). Must be outside THOR's indexed roots." />
          <Row k="Local data" v={a?.local_data ?? "…"} mono note="Settings, encrypted AI key, cached copies of the groups this account may open (deleted when access is lost), an administrator's working index, the PDF engine (bin\pdfium-157.0.8100.dll), WebView2 data. Per Windows user." />
          <Row k="Temporary" v={a?.temp ?? "…"} mono note="Read-only copies of files opened for viewing." />
          <Row k="Exports" v="Excel files go only where the user chooses in the Save dialog (refused inside THOR)." />
        </Block>

        <Block icon={<Globe className="size-4" />} title="Network connections">
          <Row k="THOR" v="SMB, as the signed-in Windows user." />
          <Row k="AI (optional)" v={a ? a.ai_hosts.join(" · ") : "…"} mono note="HTTPS 443, only when an administrator has set up AI and approves reading specific scanned pages (or tests their key), only to the provider they chose. A team-wide monthly budget is enforced before every request. Respects HTTPS_PROXY and the Windows certificate store. Block with DisableAI or your firewall." />
          <Row k="Nothing else" v="No analytics, update checks, licence calls, fonts or scripts from the internet. The interface is inside the exe." />
        </Block>

        <Block icon={<Cpu className="size-4" />} title="Processes and components">
          <Row k="Processes" v="TracePoint.exe and the Microsoft Edge WebView2 processes Windows uses to draw the window (msedgewebview2.exe). The scanner runs inside TracePoint.exe — no Python, scripts or child processes." />
          <Row k="Opening files" v="With the Windows default program, by default as a read-only temporary copy." />
          <Row k="Built with" v="Rust · SQLite (FTS5) · PDFium 157.0.8100 (BSD-3) · Microsoft WebView2 · React · Inter font (OFL). Scanned pages are read with Windows' own OCR (Windows.Media.Ocr) when available." note="PDFium is embedded and unpacked to the local data folder; its SHA-256 is checked against the embedded copy at every start." />
        </Block>

        <Block icon={<ListChecks className="size-4" />} title="How IT can verify this">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
            <li><b>Self-test:</b> <Code>TracePoint.exe --selftest</Code> in a command prompt. It locks a test folder with Windows permissions and reads the lock back, checks the Windows sign-in and DPAPI key encryption, attempts writes into THOR paths and confirms they're refused, scans, splits by permissions and searches a test folder, and checks the PDF engine and OCR. PASS/FAIL per line.</li>
            <li><b>Permissions:</b> sign in as an account without access to a THOR folder and search for a file name you know is in it — nothing. Look in <Code>%LOCALAPPDATA%\TracePoint\cache</Code>: only groups that account can open. In the shared folder's <Code>index\</Code>, each <Code>g-…</Code> folder's Security tab matches its THOR folder.</li>
            <li><b>File activity:</b> Process Monitor, <Code>Process Name is TracePoint.exe</Code>, operations WriteFile / SetDispositionInformationFile / SetRenameInformationFile / SetSecurityFile: none on a THOR path.</li>
            <li><b>Network:</b> Resource Monitor › Network or <Code>netstat -b</Code>: SMB to THOR; 443 to the AI host only for administrators using AI.</li>
            <li><b>Approve the exe by hash</b> (AppLocker/WDAC): <Code>certutil -hashfile TracePoint.exe SHA256</Code>{a?.exe_sha256 && <> — this copy: <span className="break-all font-mono text-[11.5px]">{a.exe_sha256}</span></>}. To sign it with your own code-signing certificate: <Code>signtool sign /fd SHA256 /a TracePoint.exe</Code>.</li>
            <li><b>Remove completely:</b> delete <Code>TracePoint.exe</Code> and <Code>{a?.local_data ?? "%LOCALAPPDATA%\\TracePoint"}</Code>. The shared folder can be deleted by an administrator.</li>
          </ol>
        </Block>

        <div className="mt-6 grid grid-cols-3 gap-3 text-[12.5px]">
          <Tag icon={<Lock className="size-4" />} t="Windows permissions decide" />
          <Tag icon={<Ban className="size-4" />} t="No admin rights" />
          <Tag icon={<Package className="size-4" />} t="No installer" />
          <Tag icon={<FileLock2 className="size-4" />} t="Read-only on THOR" />
          <Tag icon={<Trash2 className="size-4" />} t="Delete to uninstall" />
          <Tag icon={<Terminal className="size-4" />} t="--selftest for IT" />
        </div>
        <div className="mt-6 text-[12px] text-[var(--color-text-faint)]">{a?.exe} · {a?.machine}</div>
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mt-6 card p-5">
      <div className="mb-3 flex items-center gap-2 text-[14.5px] font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{icon}</span>{title}</div>
      <div className="divide-y divide-[var(--color-border)]">{children}</div>
    </section>
  );
}
function Row({ k, v, note, mono }: { k: string; v: string; note?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 py-2.5 text-[13px]">
      <div className="font-medium text-[var(--color-text-muted)]">{k}</div>
      <div><div className={mono ? "break-all font-mono text-[12.5px]" : ""}>{v}</div>{note && <div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">{note}</div>}</div>
    </div>
  );
}
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}
function Tag({ icon, t }: { icon: ReactNode; t: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] p-3"><span className="text-[var(--color-ok)]">{icon}</span>{t}<Pill color="var(--color-ok)" className="ml-auto">✓</Pill></div>;
}
