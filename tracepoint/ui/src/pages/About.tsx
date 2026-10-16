import { useEffect, useState, type ReactNode } from "react";
import { Bot, Cpu, Eye, FileSearch, FolderLock, Globe, KeyRound, Link2, ListChecks, Lock, ChevronDown, ScanText, Settings2, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Mark } from "../components/ui";

interface About {
  version: string; me: string; local_data: string; temp: string; team: AppState["team"]; default_team: string;
  groups: { open: number; locked: number; hidden: number; unavailable: number };
  protected_roots: string[]; writable: string[]; ai_hosts: string[]; ai_blocked_by_it: boolean; policy_key: string;
  exe?: string; exe_sha256?: string | null; machine: string; index: { source: string };
}

const HIGHLIGHTS: { t: string; d: string; i: ReactNode; c: string }[] = [
  { t: "Talk to it", d: "“crude tower inspection reports newest first” — typos, shorthand and all. The right file comes first.", i: <FileSearch className="size-5" />, c: "var(--color-accent)" },
  { t: "Reads inside documents", d: "PDFs, Word, Excel — and scanned pages with Windows' own OCR. Search finds words on page 14.", i: <ScanText className="size-5" />, c: "#2563eb" },
  { t: "Finds the newest revision", d: "Trusts the revision written in the document, not file dates. Old copies get flagged.", i: <Sparkles className="size-5" />, c: "#d97706" },
  { t: "Connects the mess", d: "Copies, project files never moved to the equipment folder, scans named DOC123456 — tied back to their equipment.", i: <Link2 className="size-5" />, c: "#7c3aed" },
  { t: "Only what you can open", d: "Windows permissions decide. Locked folders don't exist for you — not even their names.", i: <Lock className="size-5" />, c: "#059669" },
  { t: "Your own files too", d: "Add Documents or Downloads privately. Only you see them; they never leave your PC.", i: <UserRound className="size-5" />, c: "#0891b2" },
  { t: "Never touches THOR", d: "Read-only, enforced in code and proven by the self-test. Nothing is moved, renamed or deleted.", i: <ShieldCheck className="size-5" />, c: "#16a34a" },
  { t: "No passwords", d: "Signs in with your Windows account. Nothing to install, nothing to remember.", i: <KeyRound className="size-5" />, c: "#475569" },
  { t: "AI optional, capped", d: "Off by default. Admins only, to read pages OCR can't — approved first, within a monthly budget.", i: <Bot className="size-5" />, c: "#db2777" },
];

export function AboutPage({ state }: { state: AppState }) {
  const [a, setA] = useState<About | null>(null);
  useEffect(() => { api<About>("about").then(setA); }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 py-8">
        <div className="flex items-center gap-4">
          <Mark size={56} />
          <div>
            <div className="text-[26px] font-[800] tracking-tight">Find any THOR document in seconds.</div>
            <div className="text-[14px] text-[var(--color-text-muted)]">TracePoint {state.version} · reads everything, connects the mess, shows only what you're allowed to see.</div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3">
          {HIGHLIGHTS.map((h) => (
            <div key={h.t} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xs">
              <div className="flex size-9 items-center justify-center rounded-xl text-white" style={{ background: h.c }}>{h.i}</div>
              <div className="mt-2.5 text-[15.5px] font-bold leading-snug">{h.t}</div>
              <div className="mt-1 text-[13px] leading-snug text-[var(--color-text-muted)]">{h.d}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-2xl bg-[var(--color-surface-2)] p-4">
          <div className="grid grid-cols-4 gap-3 text-center">
            {[["Scan", "THOR folders you can open — read-only"], ["Read", "Text, OCR, revisions, nameplates, dates"], ["Connect", "Copies, newer revisions, the equipment it's about"], ["Find", "Ask like a person; get the right file first"]].map(([t, d], i) => (
              <div key={t}>
                <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-[13px] font-bold text-white">{i + 1}</div>
                <div className="mt-1.5 text-[14px] font-bold">{t}</div>
                <div className="text-[12px] text-[var(--color-text-muted)]">{d}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]"><ShieldCheck className="size-4" /> For IT — click any section for the details</div>

        <Block icon={<Lock className="size-4" />} title="Who sees what: Windows permissions decide" summary="Nobody sees a file name or a word of text they couldn't open in Windows.">
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
        </Block>

        <Block icon={<Link2 className="size-4" />} title="Connections: copies, revisions, stranded documents" summary="Worked out on each PC from only the files that person can open.">
          <Row k="Fingerprint card" v="When a document is read: identifiers weighted by where they appear (title block and page-1 header count most), the revision stated in it, dates in it, nameplate numbers (National Board, serial), the scanner that made it, PDF/Office properties, and two fingerprints — exact (SHA-256) and near (text similarity)." />
          <Row k="Newest revision" v="The revision the document states beats the one in its name, which beats dates written in it, which beat file dates. A superseded copy saved last week is still flagged as old. Unsure? It only says so — it never claims." />
          <Row k="Equipment from contents" v="A scanner-named file whose page 1 or nameplate names a piece of equipment is tied to it — so searching the equipment finds it." />
          <Row k="Stranded" v="Documents about a piece of equipment that live in project, contractor or department folders are listed on its card, and in the cleanup report." />
          <Row k="Never changes THOR" v="TracePoint only points things out. Moving or deleting is for people, in Explorer." />
        </Block>

        <Block icon={<FolderLock className="size-4" />} title="Private folders" summary="Your own Documents or Downloads, searchable by you only.">
          <Row k="Who sees them" v="Only the person who added them, on that PC. Their index and text stay in that Windows profile (encrypted by Windows where IT allows EFS) and never go to the shared folder." />
          <Row k="Read-only" v="Your files are read, never changed — same guard as THOR." />
          <Row k="No AI" v="Private files are never sent to an AI provider." />
          <Row k="OneDrive" v="Online-only files aren't read, so nothing gets downloaded." />
          <Row k="IT switch" v="DisablePrivateSources = 1 (DWORD) turns this off." />
        </Block>

        <Block icon={<KeyRound className="size-4" />} title="Accounts and roles" summary="Windows sign-in. No passwords. Roles enforced by folder permissions.">
          <Row k="Sign-in" v={`Windows account of whoever started TracePoint (now: ${a?.me ?? "…"}). No TracePoint passwords, no default password, no lockouts.`} />
          <Row k="Roles" v="Administrator and Indexer are given to Windows accounts in roles.json in the shared folder; everyone else is a User. TracePoint sets the shared folder's permissions to match: administrators full control, indexers modify, all signed-in staff read only — so only they can change roles or publish an index." />
          <Row k="AI keys" v="Administrators only. Each key is encrypted by Windows for that account on that PC (DPAPI) and kept in the local data folder — never on the shared folder." />
          <Row k="Activity log" v="Scans, sharing, role and setting changes and AI use, with account and computer, in the shared folder's admin\ subfolder (administrators and indexers only). Searches are never logged." />
        </Block>

        <Block icon={<Settings2 className="size-4" />} title="IT policy (Group Policy or registry)" summary="Switch off AI or private folders; pin the shared folder.">
          <Row k="Key" v={a?.policy_key ?? "HKLM\\SOFTWARE\\Policies\\TracePoint"} mono note="Also read from HKCU. Nothing else in the registry is read or written." />
          <Row k="DisableAI" v={`DWORD 1 = no AI requests from this PC, whoever is signed in.${a ? ` Now: ${a.ai_blocked_by_it ? "blocked" : "not set"}.` : ""}`} />
          <Row k="TeamFolder" v={`String = the shared TracePoint folder for this PC; users can't change it. Without it, TracePoint looks next to the exe, then at ${a?.default_team ?? "\\\\thor\\Public\\TP\\TracePoint Data"}.`} />
        </Block>

        <Block icon={<Eye className="size-4" />} title="What it reads" summary="THOR, read-only, as the signed-in user.">
          <Row k="THOR files" v="Read-only, as the signed-in Windows user: when someone previews or opens a file; when an administrator or indexer scans (folder listings, names, sizes, dates, permissions); when document contents are read for search (each file read into memory, text kept, file released)." note="Scans and content reading run at below-normal priority with a bounded number of parallel reads." />
          <Row k="Index" v={a?.index.source ?? "…"} />
          <Row k="Protected sources" v={a ? a.protected_roots.join(" · ") || "—" : "…"} mono />
        </Block>

        <Block icon={<FolderLock className="size-4" />} title="What it writes — and the only places it can" summary="Its own folders only. Never THOR.">
          <Row k="Shared folder" v={a?.team.folder ?? "Not used on this PC"} mono note="tracepoint.json, roles.json, index\ (one locked folder per permission group), admin\ (activity log, AI ledger, scan lock). Must be outside THOR's indexed roots." />
          <Row k="Local data" v={a?.local_data ?? "…"} mono note="Settings, encrypted AI key, cached copies of the groups this account may open (deleted when access is lost), an administrator's working index, the PDF engine (bin\pdfium-157.0.8100.dll), WebView2 data. Per Windows user." />
          <Row k="Temporary" v={a?.temp ?? "…"} mono note="Read-only copies of files opened for viewing." />
          <Row k="Exports" v="Excel files go only where the user chooses in the Save dialog (refused inside THOR)." />
        </Block>

        <Block icon={<Globe className="size-4" />} title="Network connections" summary="SMB to THOR. HTTPS to an AI provider only if an admin uses AI.">
          <Row k="THOR" v="SMB, as the signed-in Windows user." />
          <Row k="AI (optional)" v={a ? a.ai_hosts.join(" · ") : "…"} mono note="HTTPS 443, only when an administrator has set up AI and approves reading specific scanned pages (or tests their key), only to the provider they chose. A team-wide monthly budget is enforced before every request. Respects HTTPS_PROXY and the Windows certificate store. Block with DisableAI or your firewall." />
          <Row k="Nothing else" v="No analytics, update checks, licence calls, fonts or scripts from the internet. The interface is inside the exe." />
        </Block>

        <Block icon={<Cpu className="size-4" />} title="Processes and components" summary="One exe + Windows WebView2. No services, no installer.">
          <Row k="Processes" v="TracePoint.exe and the Microsoft Edge WebView2 processes Windows uses to draw the window (msedgewebview2.exe). The scanner runs inside TracePoint.exe — no Python, scripts or child processes." />
          <Row k="Opening files" v="With the Windows default program, by default as a read-only temporary copy." />
          <Row k="Built with" v="Rust · SQLite (FTS5) · PDFium 157.0.8100 (BSD-3) · Microsoft WebView2 · React · Inter font (OFL). Scanned pages are read with Windows' own OCR (Windows.Media.Ocr) when available." note="PDFium is embedded and unpacked to the local data folder; its SHA-256 is checked against the embedded copy at every start." />
        </Block>

        <Block icon={<ListChecks className="size-4" />} title="How IT can verify this" summary="--selftest, Process Monitor, netstat, approve by hash.">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
            <li><b>Self-test:</b> <Code>TracePoint.exe --selftest</Code> in a command prompt. It locks a test folder with Windows permissions and reads the lock back, checks the Windows sign-in and DPAPI key encryption, attempts writes into THOR paths and confirms they're refused, scans, splits by permissions and searches a test folder, and checks the PDF engine and OCR. PASS/FAIL per line.</li>
            <li><b>Permissions:</b> sign in as an account without access to a THOR folder and search for a file name you know is in it — nothing. Look in <Code>%LOCALAPPDATA%\TracePoint\cache</Code>: only groups that account can open. In the shared folder's <Code>index\</Code>, each <Code>g-…</Code> folder's Security tab matches its THOR folder.</li>
            <li><b>File activity:</b> Process Monitor, <Code>Process Name is TracePoint.exe</Code>, operations WriteFile / SetDispositionInformationFile / SetRenameInformationFile / SetSecurityFile: none on a THOR path.</li>
            <li><b>Network:</b> Resource Monitor › Network or <Code>netstat -b</Code>: SMB to THOR; 443 to the AI host only for administrators using AI.</li>
            <li><b>Approve the exe by hash</b> (AppLocker/WDAC): <Code>certutil -hashfile TracePoint.exe SHA256</Code>{a?.exe_sha256 && <> — this copy: <span className="break-all font-mono text-[11.5px]">{a.exe_sha256}</span></>}. To sign it with your own code-signing certificate: <Code>signtool sign /fd SHA256 /a TracePoint.exe</Code>.</li>
            <li><b>Remove completely:</b> delete <Code>TracePoint.exe</Code> and <Code>{a?.local_data ?? "%LOCALAPPDATA%\\TracePoint"}</Code>. The shared folder can be deleted by an administrator.</li>
          </ol>
        </Block>

        <div className="mt-6 text-[12px] text-[var(--color-text-faint)]">{a?.exe} · {a?.machine}</div>
      </div>
    </div>
  );
}

function Block({ icon, title, summary, children }: { icon: ReactNode; title: string; summary?: string; children: ReactNode }) {
  return (
    <details className="group mt-3 card overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 hover:bg-[var(--color-surface-2)]">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">{title}</span>
          {summary && <span className="block truncate text-[12.5px] text-[var(--color-text-muted)]">{summary}</span>}
        </span>
        <ChevronDown className="size-4 shrink-0 text-[var(--color-text-faint)] transition group-open:rotate-180" />
      </summary>
      <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] px-5 pb-3">{children}</div>
    </details>
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
