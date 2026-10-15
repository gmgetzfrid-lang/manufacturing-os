// lib/thor/opener.ts — open a THOR file in its own program, from the browser.
//
// A web page may not launch a program on a file, so each Windows PC gets a
// small per-user helper, once: a "thor-open:" link handler (HKCU, no admin)
// that runs a PowerShell script. The installer is generated here with this
// org's THOR root written into it, and the script enforces it:
//
//   - only paths inside that root, given relative to it, with no ".." parts
//   - only document and media types are opened in their program
//     (PDF, CAD, Office, mail, images, video, text); anything else — and
//     every "show" — just opens Explorer with the file selected
//   - nothing is written, moved or deleted
//
// So a link from any other website can at most show a file on THOR in
// Explorer. The links:  thor-open:open?p=<rel>   thor-open:show?p=<rel>

export const OPENABLE = [
  "pdf", "dwg", "dxf", "dgn", "xls", "xlsx", "xlsm", "csv", "doc", "docx", "rtf", "txt", "log", "ppt", "pptx",
  "msg", "eml", "jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "heic", "mp4", "mov", "avi", "wmv", "plf",
] as const;

export function thorOpenUrl(action: "open" | "show", relPath: string): string {
  return `thor-open:${action}?p=${encodeURIComponent(relPath)}`;
}

const KEY = "thor-opener-installed";
export function openerInstalled(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setOpenerInstalled(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** The PowerShell the link handler runs. `root` is the share, e.g. \\thor\Equipment Files. */
export function handlerScript(root: string): string {
  const r = root.replace(/'/g, "''");
  return `# THOR opener - opens files on ${root} from the app. Read-only.
param([string]$u)
Add-Type -AssemblyName System.Windows.Forms
$root = '${r}'
$openable = @(${OPENABLE.map((e) => `'${e}'`).join(",")})
try {
  if ($u -notmatch '^thor-open:(open|show)\\?p=(.+)$') { throw "Not a THOR link." }
  $action = $Matches[1]
  $rel = [uri]::UnescapeDataString($Matches[2]) -replace '/', '\\'
  if ($rel -match '(^|[\\\\/])\\.\\.([\\\\/]|$)' -or $rel -match '^[\\\\/]' -or $rel -match ':') { throw "That path is not inside THOR." }
  $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
  if (-not $full.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw "That path is not inside THOR." }
  if (-not (Test-Path -LiteralPath $full)) { throw "Not found on THOR (moved, renamed or deleted since the index was built):\`n$full" }
  $ext = [IO.Path]::GetExtension($full).TrimStart('.').ToLower()
  if ($action -eq 'open' -and $openable -contains $ext) {
    Start-Process -FilePath $full
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $full + '"')
  }
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'THOR') | Out-Null
}
`;
}

/** A .cmd that installs the handler for the current Windows user (no admin). */
export function installerCmd(root: string): string {
  const bytes = new TextEncoder().encode(handlerScript(root));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = [
    "@echo off",
    "rem THOR opener - lets the app open files on THOR in their own programs.",
    "rem Per user, no admin. Remove with the uninstall file from the same page.",
    "setlocal",
    'set "DIR=%LOCALAPPDATA%\\ThorOpener"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    // Write the script from base64 so no quoting can break it.
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllText($env:LOCALAPPDATA + '\\ThorOpener\\thor-open.ps1', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))"`,
    'reg add "HKCU\\Software\\Classes\\thor-open" /ve /d "URL:THOR opener" /f >nul',
    'reg add "HKCU\\Software\\Classes\\thor-open" /v "URL Protocol" /d "" /f >nul',
    'reg add "HKCU\\Software\\Classes\\thor-open\\shell\\open\\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"%DIR%\\thor-open.ps1\\" \\"%%1\\"" /f >nul',
    "echo.",
    "echo THOR opener installed. Go back to the app and click Open again.",
    "echo The first time, the browser asks to allow it - tick 'Always allow' and choose Open.",
    "pause",
  ];
  return lines.join("\r\n") + "\r\n";
}

export function uninstallerCmd(): string {
  return [
    "@echo off",
    'reg delete "HKCU\\Software\\Classes\\thor-open" /f >nul 2>&1',
    'rmdir /s /q "%LOCALAPPDATA%\\ThorOpener" >nul 2>&1',
    "echo THOR opener removed.",
    "pause",
  ].join("\r\n") + "\r\n";
}

/** Hand the person a file to save — the installer, never a THOR file. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Follow a thor-open: link without leaving the page. */
export function launch(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a); a.click(); a.remove();
}
