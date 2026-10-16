//! THOR inventory scan: the Rust port of THOR_Indexer's `crawl` stage.
//!
//! Writes the same schema 2.0 rows as the Python indexer (same file and root
//! ids: "file_" + first 24 hex of SHA-256 of the Windows-normalised path), so
//! a database built by either tool can be rescanned by the other.
//!
//! Faster than the Python version:
//! * many folders are listed at once (default 8 threads), each listing one
//!   directory with Windows' large-fetch FindFirstFileEx, which returns size
//!   and dates without a separate stat per file;
//! * the existing rows are loaded once, so unchanged files need no lookup and
//!   are confirmed in one set-based UPDATE;
//! * one writer thread saves in large transactions.
//!
//! Read-only on THOR: it lists folders and reads file metadata. It never opens
//! a THOR file for writing, renames, moves or deletes anything. A file is only
//! marked missing when its folder was read successfully in this scan.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

/// Python `ntpath.normcase`: backslashes, lower case.
pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// A THOR path as the OS should open it. On Windows, paths of 240+
/// characters get the \\?\ long-path form (deep THOR folders exceed the old
/// 260 limit). Dev hosts map backslashes to slashes.
pub fn os_path(p: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if p.len() >= 240 && !p.starts_with("\\\\?\\") {
            return if let Some(rest) = p.strip_prefix("\\\\") { format!("\\\\?\\UNC\\{rest}").into() } else { format!("\\\\?\\{p}").into() };
        }
        std::path::PathBuf::from(p)
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from(p.replace('\\', "/"))
    }
}

/// Python `stable_id(prefix, *parts)`.
pub fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let raw = parts.join("\u{1f}");
    let h = Sha256::digest(raw.as_bytes());
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}_{}", &hex[..24])
}

fn utcnow() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    // RFC 3339 with microseconds and +00:00, like Python's isoformat().
    let base = crate::auth::format_utc(d.as_secs() as i64);
    format!("{}.{:06}+00:00", base.trim_end_matches('Z'), d.subsec_micros())
}

fn uuid4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("random");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Python `os.path.dirname` on Windows paths: the parent, keeping the
/// trailing backslash for a share or drive root ("\\thor\Equipment Files\").
pub fn dirname(path: &str) -> String {
    let i = path.rfind('\\').unwrap_or(0);
    let parent = &path[..i];
    let is_unc_root = parent.starts_with("\\\\") && parent[2..].matches('\\').count() == 1;
    let is_drive_root = parent.len() == 2 && parent.ends_with(':');
    if is_unc_root || is_drive_root {
        format!("{parent}\\")
    } else {
        parent.to_string()
    }
}

// ── Filename rules (ported from the Python indexer) ───────────────────────

use regex::Regex;
use std::sync::LazyLock;

static MACHINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:DOC|SCAN|IMAGE|IMG|DSC|FILE)[\s_-]?\d{5,}$").unwrap());
static RE_AFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bAFE[\s_-]?(\d{3,})\b").unwrap());
static RE_EQUIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)\.(\d+)").unwrap());
static RE_KE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(KE[\s_-]?\d{3,})\b").unwrap());
static RE_PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(\d{4}[\s_-]?[A-Z][\s_-]?\d{3,})(?:[\s_-]?SHT(?:EET)?[\s_-]?(\d+))?\b").unwrap());
static RE_SHEET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|[^A-Za-z0-9])(SHT(?:EET)?[\s_-]?(\d+))\b").unwrap());
static RE_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bREV(?:ISION)?[\s_-]?([A-Z0-9]+)\b").unwrap());
static RE_U1A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bU[\s_-]?1A\b").unwrap());
static RE_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s_]+").unwrap());
static RE_ALPHA3: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z]{3,}").unwrap());
const GENERIC: &[&str] = &["document", "drawing", "scan", "image", "file", "untitled", "new document", "copy"];

/// (type, value, raw) identifiers found in text, like Python `identifiers()`.
pub fn identifiers(text: &str) -> Vec<(&'static str, String, String)> {
    let mut out = Vec::new();
    for m in RE_AFE.captures_iter(text) {
        out.push(("afe", format!("AFE-{}", &m[1]), m[0].to_string()));
    }
    // (?<!\d)(\d{4}\.\d{1,3})(?!\d): emulated with whole digit runs.
    for m in RE_EQUIP.captures_iter(text) {
        if m[1].len() == 4 && (1..=3).contains(&m[2].len()) {
            out.push(("equipment_number", m[0].to_string(), m[0].to_string()));
        }
    }
    for m in RE_KE.captures_iter(text) {
        out.push(("drawing_ke", RE_SPACE.replace_all(&m[1].to_uppercase(), "-").to_string(), m[0].to_string()));
    }
    for m in RE_PID.captures_iter(text) {
        out.push(("pid_family", RE_SPACE.replace_all(&m[1].to_uppercase(), "-").to_string(), m[0].to_string()));
    }
    for m in RE_SHEET.captures_iter(text) {
        out.push(("sheet", RE_SPACE.replace_all(&m[2].to_uppercase(), "-").to_string(), m[2].to_string()));
    }
    for m in RE_REV.captures_iter(text) {
        out.push(("revision", RE_SPACE.replace_all(&m[0].to_uppercase(), "-").to_string(), m[0].to_string()));
    }
    for m in RE_U1A.find_iter(text) {
        out.push(("u1a", "U-1A".into(), m.as_str().to_string()));
    }
    out
}

fn split_name(name: &str) -> (&str, String) {
    // Python os.path.splitext: leading dots are not an extension.
    match name.rfind('.') {
        Some(i) if i > 0 && !name[..i].chars().all(|c| c == '.') => (&name[..i], name[i..].to_lowercase()),
        _ => (name, String::new()),
    }
}

pub fn classify_filename(name: &str) -> &'static str {
    let (stem, _) = split_name(name);
    let stem = stem.trim();
    if stem.is_empty() {
        return "UNKNOWN";
    }
    if MACHINE_RE.is_match(stem) {
        return "MACHINE_GENERATED";
    }
    if GENERIC.contains(&stem.to_lowercase().as_str()) {
        return "GENERIC";
    }
    if !identifiers(stem).is_empty() {
        return "STRUCTURED_IDENTIFIER";
    }
    if RE_ALPHA3.is_match(stem) {
        return "SEMANTIC";
    }
    "UNKNOWN"
}

pub fn inspection_score(path: &str, size: i64, fclass: &str, depth: usize) -> f64 {
    let mut s: f64 = 0.12;
    let (_, ext) = split_name(path.rsplit('\\').next().unwrap_or(path));
    if fclass == "STRUCTURED_IDENTIFIER" {
        s += 0.20;
    }
    if fclass == "MACHINE_GENERATED" {
        s += 0.16;
    }
    if [".pdf", ".docx", ".xlsx", ".xlsm", ".txt", ".csv", ".xml", ".html", ".htm"].contains(&ext.as_str()) {
        s += 0.18;
    }
    let low = path.to_lowercase();
    if ["drawing", "inspection", "code document", "project", "afe", "engineering", "issued for construction"].iter().any(|x| low.contains(x)) {
        s += 0.18;
    }
    if ["archive", "temp", "backup", "personal"].iter().any(|x| low.contains(x)) {
        s -= 0.05;
    }
    if size > 0 && size < 20_000_000 {
        s += 0.05;
    }
    if depth >= 2 {
        s += 0.03;
    }
    s.clamp(0.0, 1.0)
}

// ── Directory listing ─────────────────────────────────────────────────────

pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub reparse: bool,
    pub size: i64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    pub readonly: bool,
    /// Who may read it (fingerprint), or why that couldn't be read.
    pub access: Option<Result<String, String>>,
}

#[cfg(windows)]
fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE, ERROR_NO_MORE_FILES, ERROR_FILE_NOT_FOUND};
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW, FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW};
    // Long paths: \\?\UNC\server\share\… or \\?\C:\…
    let long = if path.starts_with("\\\\?\\") {
        path.to_string()
    } else if let Some(rest) = path.strip_prefix("\\\\") {
        format!("\\\\?\\UNC\\{rest}")
    } else {
        format!("\\\\?\\{path}")
    };
    let pattern: Vec<u16> = std::ffi::OsStr::new(&format!("{}\\*", long.trim_end_matches('\\'))).encode_wide().chain(std::iter::once(0)).collect();
    let ft = |lo: u32, hi: u32| -> i64 {
        let t = ((hi as u64) << 32 | lo as u64) as i64;
        (t - 116_444_736_000_000_000) * 100
    };
    let mut out = Vec::new();
    unsafe {
        let mut d: WIN32_FIND_DATAW = std::mem::zeroed();
        let h = FindFirstFileExW(pattern.as_ptr(), FindExInfoBasic, &mut d as *mut _ as *mut _, FindExSearchNameMatch, std::ptr::null(), FIND_FIRST_EX_LARGE_FETCH);
        if h == INVALID_HANDLE_VALUE {
            let e = GetLastError();
            if e == ERROR_FILE_NOT_FOUND {
                return Ok(out);
            }
            return Err(std::io::Error::from_raw_os_error(e as i32).to_string());
        }
        loop {
            let len = d.cFileName.iter().position(|&c| c == 0).unwrap_or(d.cFileName.len());
            let name = String::from_utf16_lossy(&d.cFileName[..len]);
            if name != "." && name != ".." {
                let attrs = d.dwFileAttributes;
                out.push(Entry {
                    name,
                    is_dir: attrs & 0x10 != 0,
                    reparse: attrs & 0x400 != 0,
                    size: ((d.nFileSizeHigh as u64) << 32 | d.nFileSizeLow as u64) as i64,
                    mtime_ns: ft(d.ftLastWriteTime.dwLowDateTime, d.ftLastWriteTime.dwHighDateTime),
                    ctime_ns: ft(d.ftCreationTime.dwLowDateTime, d.ftCreationTime.dwHighDateTime),
                    readonly: attrs & 0x1 != 0,
                    access: None,
                });
            }
            if FindNextFileW(h, &mut d) == 0 {
                let e = GetLastError();
                FindClose(h);
                if e != ERROR_NO_MORE_FILES {
                    return Err(std::io::Error::from_raw_os_error(e as i32).to_string());
                }
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(not(windows))]
fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    // Development/test hosts: the same tree, addressed with Windows-style
    // separators by the caller.
    let real = path.replace('\\', "/");
    let rd = std::fs::read_dir(&real).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let Ok(md) = e.path().symlink_metadata() else { continue };
        let ns = |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i64).unwrap_or(0);
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            reparse: md.file_type().is_symlink(),
            size: md.len() as i64,
            mtime_ns: ns(md.modified()),
            ctime_ns: ns(md.created()),
            readonly: md.permissions().readonly(),
            access: None,
        });
    }
    Ok(out)
}

#[cfg(windows)]
fn lower_thread_priority() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}
#[cfg(not(windows))]
fn lower_thread_priority() {}

// ── The scan ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Progress {
    pub root: String,
    pub phase: &'static str,
    pub dirs: usize,
    pub files: usize,
    pub new: usize,
    pub changed: usize,
    pub missing: usize,
    pub issues: usize,
    pub files_per_sec: f64,
    pub elapsed_s: f64,
    pub current: String,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Summary {
    pub crawl_id: String,
    pub root_id: String,
    pub status: String,
    pub progress: Progress,
    /// New or changed files: the only ones the content stage needs to read.
    #[serde(skip)]
    pub touched: Vec<String>,
}

pub struct Options {
    pub workers: usize,
    pub cancel: Arc<AtomicBool>,
    /// Read each file's Windows permissions (who may open it). Needed before
    /// an index can be shared; read-only, one request per file.
    pub permissions: bool,
}

enum Msg {
    Dir { path: String, depth: usize, entries: Vec<Entry> },
    Failed { path: String, error: String },
    Skipped { path: String },
}

/// Ensures the schema 2.0 tables the scan writes exist (a database made by
/// the Python indexer already has them; extra columns are left alone).
pub fn ensure_schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS roots(root_id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,norm_path TEXT UNIQUE NOT NULL,
           created_at TEXT NOT NULL,last_crawl_at TEXT,explorer_completed_at TEXT,enabled INTEGER NOT NULL DEFAULT 1);
         CREATE TABLE IF NOT EXISTS crawls(crawl_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,started_at TEXT NOT NULL,
           completed_at TEXT,status TEXT NOT NULL,files_seen INTEGER DEFAULT 0,dirs_seen INTEGER DEFAULT 0,issues INTEGER DEFAULT 0);
         CREATE TABLE IF NOT EXISTS files(file_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,path TEXT NOT NULL,norm_path TEXT UNIQUE NOT NULL,
           filename TEXT NOT NULL,stem TEXT NOT NULL,extension TEXT NOT NULL,parent_path TEXT NOT NULL,depth INTEGER NOT NULL,
           size_bytes INTEGER,mtime_ns INTEGER,ctime_ns INTEGER,mode INTEGER,filename_class TEXT NOT NULL,useful INTEGER NOT NULL,
           first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,first_crawl TEXT NOT NULL,last_crawl TEXT NOT NULL,
           observation_state TEXT NOT NULL,change_state TEXT NOT NULL,content_hash TEXT,hash_alg TEXT,inspection_value REAL DEFAULT 0,
           parsed_at TEXT,content_excerpt TEXT,content_method TEXT,information_value REAL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS ix_files_root ON files(root_id);
         CREATE TABLE IF NOT EXISTS identifiers(identifier_id TEXT PRIMARY KEY,file_id TEXT,root_id TEXT,type TEXT NOT NULL,
           value TEXT NOT NULL,raw_value TEXT,source TEXT NOT NULL,confidence REAL NOT NULL,semantic_power REAL DEFAULT .5,created_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS ix_ident_file ON identifiers(file_id);
         CREATE TABLE IF NOT EXISTS issues(issue_id TEXT PRIMARY KEY,crawl_id TEXT,root_id TEXT,path TEXT,reason_code TEXT NOT NULL,
           message TEXT,created_at TEXT NOT NULL,details_json TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS patterns(root_id TEXT NOT NULL,pattern_type TEXT NOT NULL,value TEXT NOT NULL,count INTEGER NOT NULL,
           example TEXT,last_updated TEXT NOT NULL,PRIMARY KEY(root_id,pattern_type,value));
         CREATE TABLE IF NOT EXISTS tp_access(class TEXT PRIMARY KEY,root_id TEXT NOT NULL,readers TEXT NOT NULL,broad INTEGER NOT NULL,
           files INTEGER NOT NULL DEFAULT 0,updated TEXT);
         CREATE TABLE IF NOT EXISTS tp_file_access(file_id TEXT PRIMARY KEY,class TEXT,problem TEXT);
         CREATE INDEX IF NOT EXISTS ix_file_access_class ON tp_file_access(class);",
    )
}

/// Registers `root` (Python `register_root`) and returns its root_id.
pub fn register_root(c: &Connection, root: &str) -> rusqlite::Result<String> {
    let root = root.trim_end_matches(['\\', '/']).to_string();
    let n = norm_path(&root);
    if let Some(id) = c.query_row("SELECT root_id FROM roots WHERE norm_path=?1", [&n], |r| r.get::<_, String>(0)).optional()? {
        return Ok(id);
    }
    let rid = stable_id("root", &[&n]);
    c.execute("INSERT INTO roots(root_id,path,norm_path,created_at) VALUES(?1,?2,?3,?4)", params![rid, root, n, utcnow()])?;
    Ok(rid)
}

/// Scans one THOR root into `c`. `progress` is called about four times a second.
pub fn scan(c: &mut Connection, root: &str, opts: &Options, progress: &dyn Fn(&Progress)) -> Result<Summary, String> {
    let e = |x: rusqlite::Error| format!("Index database error: {x}");
    let t0 = Instant::now();
    ensure_schema(c).map_err(e)?;
    let root = root.trim_end_matches(['\\', '/']).to_string();
    let rid = register_root(c, &root).map_err(e)?;
    let cid = uuid4();
    let started = utcnow();
    c.execute("INSERT INTO crawls(crawl_id,root_id,started_at,status) VALUES(?1,?2,?3,'running')", params![cid, rid, started]).map_err(e)?;

    // Everything already known under this root, loaded once.
    let mut known: HashMap<String, (String, i64, i64)> = HashMap::new();
    {
        let mut st = c.prepare("SELECT norm_path,file_id,coalesce(size_bytes,-1),coalesce(mtime_ns,0) FROM files WHERE root_id=?1").map_err(e)?;
        let rows = st.query_map([&rid], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))).map_err(e)?;
        for r in rows.flatten() {
            known.insert(r.0, r.1);
        }
    }

    // Readers: a pool of threads, each listing one folder at a time.
    let workers = opts.workers.clamp(1, 32);
    let (tx, rx) = mpsc::sync_channel::<Msg>(4096);
    let cancel = opts.cancel.clone();
    let pending = Arc::new(AtomicUsize::new(0));
    let perms = opts.permissions;
    let reader = {
        let root = root.clone();
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .thread_name(|i| format!("thor-read-{i}"))
                .start_handler(|_| lower_thread_priority())
                .build()
                .expect("thread pool");
            type Sids = Arc<std::sync::Mutex<HashMap<String, String>>>;
            #[allow(clippy::too_many_arguments)]
            fn visit<'s>(s: &rayon::Scope<'s>, path: String, depth: usize, tx: mpsc::SyncSender<Msg>, cancel: Arc<AtomicBool>, pending: Arc<AtomicUsize>, perms: bool, sids: Sids) {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                match list_dir(&path) {
                    Ok(mut entries) => {
                        if perms {
                            for en in entries.iter_mut().filter(|x| !x.is_dir && !x.reparse) {
                                let full = format!("{}\\{}", path.trim_end_matches('\\'), en.name);
                                en.access = Some(crate::acl::read_access(&full, &sids).map(|r| r.fingerprint()));
                            }
                        }
                        for en in entries.iter().filter(|x| x.is_dir) {
                            let child = format!("{}\\{}", path.trim_end_matches('\\'), en.name);
                            if en.reparse {
                                let _ = tx.send(Msg::Skipped { path: child });
                                continue;
                            }
                            let (tx, cancel, pending, sids) = (tx.clone(), cancel.clone(), pending.clone(), sids.clone());
                            pending.fetch_add(1, Ordering::Relaxed);
                            s.spawn(move |s| {
                                visit(s, child, depth + 1, tx, cancel, pending.clone(), perms, sids);
                                pending.fetch_sub(1, Ordering::Relaxed);
                            });
                        }
                        let _ = tx.send(Msg::Dir { path, depth, entries });
                    }
                    Err(error) => {
                        let _ = tx.send(Msg::Failed { path, error });
                    }
                }
            }
            pool.scope(|s| visit(s, root, 0, tx, cancel, pending, perms, Arc::new(std::sync::Mutex::new(HashMap::new()))));
        })
    };

    // Writer: this thread, one transaction per batch.
    let now = utcnow();
    let mut p = Progress { root: root.clone(), phase: "scanning", ..Default::default() };
    let mut seen: HashSet<String> = HashSet::with_capacity(known.len() + 1024);
    let mut unchanged: Vec<String> = Vec::with_capacity(known.len());
    let mut touched: Vec<String> = Vec::new();
    let mut failed_dirs: Vec<String> = Vec::new();
    let mut patterns: HashMap<(&'static str, String), (i64, String)> = HashMap::new();
    let mut last_emit = Instant::now();
    let root_norm_len = root.len();
    let tx_db = c.transaction().map_err(e)?;
    {
        let mut ins = tx_db
            .prepare(
                "INSERT INTO files(file_id,root_id,path,norm_path,filename,stem,extension,parent_path,depth,size_bytes,mtime_ns,ctime_ns,mode,
                 filename_class,useful,first_seen,last_seen,first_crawl,last_crawl,observation_state,change_state,inspection_value)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?17,?17,'current','new',?18)",
            )
            .map_err(e)?;
        let mut upd = tx_db
            .prepare(
                "UPDATE files SET path=?2,filename=?3,stem=?4,extension=?5,parent_path=?6,depth=?7,size_bytes=?8,mtime_ns=?9,ctime_ns=?10,mode=?11,
                 filename_class=?12,useful=?13,last_seen=?14,last_crawl=?15,observation_state='current',change_state='changed',inspection_value=?16
                 WHERE file_id=?1",
            )
            .map_err(e)?;
        let mut del_ident = tx_db.prepare("DELETE FROM identifiers WHERE file_id=?1 AND source='path_or_filename'").map_err(e)?;
        let mut ins_ident = tx_db.prepare("INSERT OR REPLACE INTO identifiers VALUES(?1,?2,?3,?4,?5,?6,'path_or_filename',1.0,?7,?8)").map_err(e)?;
        let mut ins_issue = tx_db.prepare("INSERT OR REPLACE INTO issues VALUES(?1,?2,?3,?4,?5,?6,?7,'{}')").map_err(e)?;
        let mut ins_acc = tx_db.prepare("INSERT OR REPLACE INTO tp_file_access(file_id,class,problem) VALUES(?1,?2,?3)").map_err(e)?;
        let mut ins_class = tx_db.prepare("INSERT INTO tp_access(class,root_id,readers,broad,updated) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(class) DO UPDATE SET updated=excluded.updated").map_err(e)?;
        let mut classes: HashSet<String> = HashSet::new();
        let mut record_access = |fid: &str, acc: &Option<Result<String, String>>| -> Result<(), String> {
            match acc {
                None => {}
                Some(Ok(fp)) => {
                    let class = stable_id("access", &[&rid, fp]);
                    if classes.insert(class.clone()) {
                        let broad = crate::acl::ReadAccess::parse_fingerprint(fp).broad();
                        ins_class.execute(params![class, rid, fp, broad as i64, now]).map_err(e)?;
                    }
                    ins_acc.execute(params![fid, class, Option::<String>::None]).map_err(e)?;
                }
                Some(Err(why)) => {
                    ins_acc.execute(params![fid, Option::<String>::None, why]).map_err(e)?;
                }
            }
            Ok(())
        };
        let mut issue = |path: &str, code: &str, msg: &str, p: &mut Progress| {
            let id = stable_id("issue", &[&cid, path, code]);
            let _ = ins_issue.execute(params![id, cid, rid, path, code, msg, now]);
            p.issues += 1;
        };

        for msg in rx.iter() {
            match msg {
                Msg::Skipped { path } => issue(&path, "REPARSE_POINT_SKIPPED", "Reparse point not traversed", &mut p),
                Msg::Failed { path, error } => {
                    let code = if error.to_lowercase().contains("denied") { "PERMISSION_DENIED" } else { "DIRECTORY_IO_ERROR" };
                    issue(&path, code, &error, &mut p);
                    failed_dirs.push(norm_path(&path));
                }
                Msg::Dir { path, depth, entries } => {
                    p.dirs += 1;
                    p.current = path.clone();
                    for en in entries.into_iter().filter(|x| !x.is_dir) {
                        if en.reparse {
                            continue;
                        }
                        let full = format!("{}\\{}", path.trim_end_matches('\\'), en.name);
                        let n = norm_path(&full);
                        let (stem, ext) = split_name(&en.name);
                        let lname = en.name.to_lowercase();
                        let incidental = ["thumbs.db", "desktop.ini", ".ds_store"].contains(&lname.as_str()) || [".dwl", ".dwl2", ".tmp", ".lock"].contains(&ext.as_str()) || en.name.starts_with("~$");
                        let fc = if incidental { "GENERIC" } else { classify_filename(&en.name) };
                        let useful = (en.size > 0 && !incidental) as i64;
                        let score = if incidental { 0.0 } else { inspection_score(&full, en.size, fc, depth) };
                        let mode: i64 = if en.readonly { 0o100444 } else { 0o100666 };
                        let parent = dirname(&full);
                        p.files += 1;
                        if en.size == 0 {
                            issue(&full, "ZERO_BYTE_FILE", "Retained for audit; excluded from useful search.", &mut p);
                        }
                        // Patterns (Stage Zero observations), counted per file like Python.
                        let ext_key = if ext.is_empty() { "<none>".to_string() } else { ext.clone() };
                        patterns.entry(("extension", ext_key)).or_insert((0, full.clone())).0 += 1;
                        patterns.entry(("filename_class", fc.to_string())).or_insert((0, full.clone())).0 += 1;
                        if path.len() > root_norm_len {
                            for seg in path[root_norm_len..].split('\\').filter(|s| !s.is_empty()) {
                                patterns.entry(("directory_name", seg.to_string())).or_insert((0, full.clone())).0 += 1;
                            }
                        }
                        let fid;
                        match known.get(&n) {
                            Some((id, size, mtime)) if *size == en.size && *mtime == en.mtime_ns => {
                                record_access(id, &en.access)?;
                                seen.insert(n);
                                unchanged.push(id.clone());
                                continue;
                            }
                            Some((id, _, _)) => {
                                fid = id.clone();
                                upd.execute(params![fid, full, en.name, stem, ext, parent, depth as i64, en.size, en.mtime_ns, en.ctime_ns, mode, fc, useful, now, cid, score]).map_err(e)?;
                                p.changed += 1;
                            }
                            None => {
                                fid = stable_id("file", &[&n]);
                                ins.execute(params![fid, rid, full, n, en.name, stem, ext, parent, depth as i64, en.size, en.mtime_ns, en.ctime_ns, mode, fc, useful, now, cid, score]).map_err(e)?;
                                p.new += 1;
                            }
                        }
                        record_access(&fid, &en.access)?;
                        seen.insert(n);
                        touched.push(fid.clone());
                        del_ident.execute([&fid]).map_err(e)?;
                        let rel = &full[root_norm_len.min(full.len())..];
                        for (typ, val, raw) in identifiers(rel.trim_start_matches('\\')) {
                            let sem = if ["equipment_number", "afe", "drawing_ke", "pid_family"].contains(&typ) { 0.9 } else { 0.65 };
                            let iid = stable_id("ident", &[&fid, typ, &val, "path"]);
                            ins_ident.execute(params![iid, fid, rid, typ, val, raw, sem, now]).map_err(e)?;
                        }
                    }
                }
            }
            if last_emit.elapsed().as_millis() >= 250 {
                p.elapsed_s = t0.elapsed().as_secs_f64();
                p.files_per_sec = p.files as f64 / p.elapsed_s.max(0.01);
                progress(&p);
                last_emit = Instant::now();
            }
        }
    }
    let _ = reader.join();
    let cancelled = cancel.load(Ordering::Relaxed);

    // Unchanged files: one set-based confirmation.
    p.phase = "saving";
    progress(&p);
    tx_db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS seen_ids(id TEXT PRIMARY KEY); DELETE FROM temp.seen_ids;").map_err(e)?;
    {
        let mut st = tx_db.prepare("INSERT OR IGNORE INTO temp.seen_ids VALUES(?1)").map_err(e)?;
        for id in &unchanged {
            st.execute([id]).map_err(e)?;
        }
    }
    tx_db
        .execute(
            "UPDATE files SET last_seen=?1,last_crawl=?2,observation_state='current',change_state='unchanged' WHERE file_id IN (SELECT id FROM temp.seen_ids)",
            params![now, cid],
        )
        .map_err(e)?;

    // Missing: known before, not seen now, and not under a folder we couldn't read.
    let status = if cancelled {
        "interrupted"
    } else if failed_dirs.is_empty() {
        "inventory_complete"
    } else {
        "inventory_partial"
    };
    if !cancelled {
        failed_dirs.sort();
        let under_failed = |n: &str| failed_dirs.iter().any(|d| n.starts_with(d.as_str()) && n.as_bytes().get(d.len()) == Some(&b'\\'));
        let mut st = tx_db.prepare("UPDATE files SET observation_state='not_currently_observed',change_state='missing' WHERE file_id=?1 AND observation_state<>'not_currently_observed'").map_err(e)?;
        for (n, (id, _, _)) in &known {
            if !seen.contains(n) && !under_failed(n) {
                p.missing += st.execute([id]).map_err(e)?;
            }
        }
        if opts.permissions {
            // Files no longer present don't hold a lock group open.
            tx_db
                .execute(
                    "UPDATE tp_access SET files=(SELECT count(*) FROM tp_file_access a JOIN files f USING(file_id)
                       WHERE a.class=tp_access.class AND f.observation_state='current') WHERE root_id=?1",
                    [&rid],
                )
                .map_err(e)?;
            tx_db.execute("DELETE FROM tp_access WHERE root_id=?1 AND files=0", [&rid]).map_err(e)?;
        }
        tx_db.execute("DELETE FROM patterns WHERE root_id=?1", [&rid]).map_err(e)?;
        let mut st = tx_db.prepare("INSERT OR REPLACE INTO patterns VALUES(?1,?2,?3,?4,?5,?6)").map_err(e)?;
        for ((typ, val), (count, example)) in &patterns {
            if *count > 0 {
                st.execute(params![rid, typ, val, count, example, now]).map_err(e)?;
            }
        }
    }
    let done = utcnow();
    tx_db
        .execute(
            "UPDATE crawls SET completed_at=?1,status=?2,files_seen=?3,dirs_seen=?4,issues=?5 WHERE crawl_id=?6",
            params![if cancelled { None } else { Some(&done) }, status, p.files as i64, p.dirs as i64, p.issues as i64, cid],
        )
        .map_err(e)?;
    if !cancelled {
        tx_db.execute("UPDATE roots SET last_crawl_at=?1 WHERE root_id=?2", params![done, rid]).map_err(e)?;
    }
    tx_db.commit().map_err(e)?;
    p.phase = if cancelled { "cancelled" } else { "done" };
    p.elapsed_s = t0.elapsed().as_secs_f64();
    p.files_per_sec = p.files as f64 / p.elapsed_s.max(0.01);
    progress(&p);
    Ok(Summary { crawl_id: cid, root_id: rid, status: status.into(), progress: p, touched })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_python() {
        // Python: stable_id("root", normpath(r"\\thor\Equipment Files"))
        assert_eq!(stable_id("root", &[&norm_path(r"\\thor\Equipment Files")]), "root_2de7c5872a847fbfa596891d");
        assert_eq!(dirname(r"\\thor\Equipment Files\x.lnk"), r"\\thor\Equipment Files\");
        assert_eq!(dirname(r"\\thor\Equipment Files\5600 - LRU\x.pdf"), r"\\thor\Equipment Files\5600 - LRU");
        assert_eq!(classify_filename("5610.15 UT Survey.pdf"), "STRUCTURED_IDENTIFIER");
        assert_eq!(classify_filename("DSC00012345.jpg"), "MACHINE_GENERATED");
        assert_eq!(classify_filename("Field Notes.pdf"), "SEMANTIC");
        let ids = identifiers("2002-D 2001_SHT04 - Rev33 5610.15 U-1A 15610.150");
        assert!(ids.iter().any(|x| x.0 == "equipment_number" && x.1 == "5610.15"));
        assert!(!ids.iter().any(|x| x.1 == "5610.150"));
        assert!(ids.iter().any(|x| x.0 == "sheet" && x.1 == "SHT04"));
        assert!(ids.iter().any(|x| x.0 == "u1a"));
    }

    #[test]
    fn scan_updates_and_marks_missing() {
        let dir = std::env::temp_dir().join(format!("tp-crawl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("5600 - LRU/10 - VESSELS/5610.15 V-2/INSPECTIONS")).unwrap();
        std::fs::write(dir.join("5600 - LRU/10 - VESSELS/5610.15 V-2/INSPECTIONS/5610.15 UT Survey 2022.pdf"), b"pdf").unwrap();
        std::fs::write(dir.join("5600 - LRU/readme.txt"), b"hello").unwrap();
        let root = dir.to_string_lossy().replace('/', "\\");
        let mut c = Connection::open_in_memory().unwrap();
        let opts = Options { workers: 4, cancel: Arc::new(AtomicBool::new(false)), permissions: true };
        let s1 = scan(&mut c, &root, &opts, &|_| {}).unwrap();
        assert_eq!(s1.progress.files, 2);
        assert_eq!(s1.progress.new, 2);
        assert_eq!(s1.status, "inventory_complete");
        // Rescan: nothing new; then a change and a removal.
        let s2 = scan(&mut c, &root, &opts, &|_| {}).unwrap();
        assert_eq!((s2.progress.new, s2.progress.changed, s2.progress.missing), (0, 0, 0));
        std::fs::remove_file(dir.join("5600 - LRU/readme.txt")).unwrap();
        std::fs::write(dir.join("5600 - LRU/10 - VESSELS/5610.15 V-2/INSPECTIONS/5610.15 UT Survey 2022.pdf"), b"pdf v2").unwrap();
        let s3 = scan(&mut c, &root, &opts, &|_| {}).unwrap();
        assert_eq!((s3.progress.new, s3.progress.changed, s3.progress.missing), (0, 1, 1));
        let eq: i64 = c.query_row("select count(*) from identifiers where type='equipment_number' and value='5610.15'", [], |r| r.get(0)).unwrap();
        assert_eq!(eq, 1);
        let gone: String = c.query_row("select observation_state from files where filename='readme.txt'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, "not_currently_observed");
        let classes: i64 = c.query_row("select count(*) from tp_access", [], |r| r.get(0)).unwrap();
        let recorded: i64 = c.query_row("select count(*) from tp_file_access where class is not null", [], |r| r.get(0)).unwrap();
        assert_eq!((classes, recorded), (1, 2), "every file's readers recorded");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
