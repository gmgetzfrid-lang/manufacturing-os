//! The TracePoint service: every command the interface can call, with all
//! permission checks done here (the interface is never trusted).
//!
//! Platform-neutral. The Windows app plugs in a `Platform` that opens files,
//! shows dialogs and pushes events; the dev server plugs in a stub.
//!
//! Who you are is your Windows account; what you can find is what Windows
//! lets you open (see `acl`, `partition`, `team`).

use crate::acl;
use crate::auth::{self, Role, Session, UserStore};
use crate::engine::{Engine, SearchRequest};
use crate::guard::{DriveResolver, Guard};
use crate::index::Index;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub trait Platform: Send + Sync {
    fn open_path(&self, p: &Path) -> Result<(), String>;
    fn reveal(&self, p: &Path) -> Result<(), String>;
    fn save_dialog(&self, title: &str, default_name: &str, ext: &str) -> Option<PathBuf>;
    fn open_dialog(&self, title: &str, ext: &str) -> Option<PathBuf>;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn emit(&self, event: &str, payload: Value);
    fn drive_resolver(&self) -> Option<DriveResolver> {
        None
    }
    fn machine(&self) -> String {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
    /// The folder TracePoint.exe was started from (for shared setups).
    fn exe_dir(&self) -> Option<PathBuf> {
        None
    }
}

/// The shared data folder people find automatically: next to the exe.
pub const TEAM_DIR_NAME: &str = "TracePoint Data";

#[derive(Clone, Debug, Default, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct LocalConfig {
    /// The shared folder this PC joined.
    pub team_folder: Option<String>,
}

pub struct Paths {
    pub local: PathBuf,
    pub temp: PathBuf,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IndexState {
    pub ready: bool,
    pub message: String,
    pub source: String,
    pub source_kind: String,
    pub error: Option<String>,
}

/// Where this PC's data comes from.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TeamState {
    /// "team" (joined a shared folder), "offline" (joined, can't reach it),
    /// "standalone" (this PC only).
    pub mode: String,
    pub folder: Option<String>,
    /// How the folder was found: "policy", "joined", "next_to_exe", "default".
    pub found_by: String,
    /// A shared setup exists that this PC could join (shown on first run).
    pub available: Option<String>,
    /// Set by IT policy: can't be changed in the app.
    pub forced: bool,
}

pub struct Service {
    pub platform: Box<dyn Platform>,
    pub guard: Guard,
    pub paths: Paths,
    me: acl::Identity,
    engine: RwLock<Option<Arc<Engine>>>,
    index_state: RwLock<IndexState>,
    team: RwLock<TeamState>,
    users: Mutex<UserStore>,
    session: Mutex<Option<Session>>,
    config: RwLock<LocalConfig>,
    exe_dir: Option<PathBuf>,
    /// What this PC loaded from the shared index (counts only).
    groups: RwLock<crate::team::Loaded>,
    /// The last time this PC shared an index, and what was held back.
    published: Mutex<Option<crate::team::Published>>,
    /// One publish at a time from this PC (a scan and a correction can overlap).
    publishing: Mutex<()>,
    scan: Mutex<ScanState>,
    scan_cancel: Arc<AtomicBool>,
    scan_lock: Mutex<Option<PathBuf>>,
    content: Mutex<ContentState>,
    content_cancel: Arc<AtomicBool>,
    /// pdfium.dll (unpacked from the exe by the app) or libpdfium.so (dev).
    pdfium_lib: RwLock<Option<PathBuf>>,
    manifest_seen: Mutex<Option<String>>,
}


/// Progress of reading document contents.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ContentState {
    pub running: bool,
    pub phase: String,
    pub total: usize,
    pub done: usize,
    pub pages: usize,
    pub ocr_pages: usize,
    pub unreadable_pages: usize,
    pub errors: usize,
    pub files_per_min: f64,
    pub eta_min: Option<f64>,
    pub current: Option<String>,
    pub started: Option<String>,
    pub finished: Option<String>,
    pub error: Option<String>,
    pub pdf_engine: bool,
    pub ocr_engine: bool,
    pub files_read_total: usize,
}

/// What the Sources page shows while THOR is being rescanned.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ScanState {
    pub running: bool,
    pub root: Option<String>,
    pub phase: String,
    pub files: usize,
    pub dirs: usize,
    pub new: usize,
    pub changed: usize,
    pub missing: usize,
    pub errors: usize,
    pub files_per_sec: f64,
    pub started: Option<String>,
    pub finished: Option<String>,
    pub error: Option<String>,
    pub log: Vec<String>,
}

#[derive(Debug)]
pub struct ApiError {
    pub code: u16,
    pub message: String,
}

impl ApiError {
    fn new(code: u16, m: impl Into<String>) -> ApiError {
        ApiError { code, message: m.into() }
    }
}

impl From<auth::AuthError> for ApiError {
    fn from(e: auth::AuthError) -> Self {
        ApiError::new(400, e.0)
    }
}
impl From<crate::guard::GuardError> for ApiError {
    fn from(e: crate::guard::GuardError) -> Self {
        ApiError::new(403, e.to_string())
    }
}

type R = Result<Value, ApiError>;

fn arg<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, ApiError> {
    serde_json::from_value(v.clone()).map_err(|e| ApiError::new(400, format!("Bad request: {e}")))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn sha2_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Rows of one report sheet.
pub struct Rows(pub Vec<crate::export::CleanupRow>);
impl Rows {
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn clone_rows(&self) -> Vec<crate::export::CleanupRow> {
        self.0.iter().map(|r| crate::export::CleanupRow { file: r.file.clone(), path: r.path.clone(), what: r.what.clone(), better: r.better.clone(), better_path: r.better_path.clone(), why: r.why.clone() }).collect()
    }
}


impl Service {
    pub fn new(platform: Box<dyn Platform>, local: PathBuf) -> Result<Arc<Service>, String> {
        let me = acl::current_user();
        Self::new_as(platform, local, me)
    }

    /// As a given Windows account (tests).
    pub fn new_as(platform: Box<dyn Platform>, local: PathBuf, me: acl::Identity) -> Result<Arc<Service>, String> {
        let guard = Guard::new(platform.drive_resolver());
        let temp = std::env::temp_dir().join("TracePoint");
        std::fs::create_dir_all(&local).map_err(|e| format!("Cannot create {}: {e}", local.display()))?;
        guard.allow(&local).map_err(|e| e.to_string())?;
        guard.allow(&temp).map_err(|e| e.to_string())?;
        let mut config: LocalConfig = std::fs::read(local.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let exe_dir = platform.exe_dir();
        let team = Self::find_team(&config, exe_dir.as_deref());
        if let Some(f) = &team.folder {
            guard.allow(Path::new(f)).map_err(|e| e.to_string())?;
            if matches!(team.found_by.as_str(), "next_to_exe" | "default") {
                // Found an existing setup: remember it, so a later outage
                // shows "can't reach THOR" instead of an empty PC-only setup.
                config.team_folder = Some(f.clone());
                let _ = guard.write(&local.join("config.json"), serde_json::to_string_pretty(&config).unwrap().as_bytes());
            }
        }
        let users = match (&team.mode[..], &team.folder) {
            ("team" | "offline", Some(f)) => UserStore::open(me.clone(), &local, Some(Path::new(f))),
            _ => UserStore::open(me.clone(), &local, None),
        }
        .map_err(|e| e.0)?;
        let session = users.session();
        Ok(Arc::new(Service {
            platform,
            guard,
            paths: Paths { local, temp },
            me,
            engine: RwLock::new(None),
            index_state: RwLock::new(IndexState { ready: false, message: "Starting…".into(), source: String::new(), source_kind: String::new(), error: None }),
            team: RwLock::new(team),
            users: Mutex::new(users),
            session: Mutex::new(Some(session)),
            config: RwLock::new(config),
            exe_dir,
            groups: RwLock::new(Default::default()),
            published: Mutex::new(None),
            publishing: Mutex::new(()),
            scan: Mutex::new(ScanState::default()),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            scan_lock: Mutex::new(None),
            content: Mutex::new(ContentState::default()),
            content_cancel: Arc::new(AtomicBool::new(false)),
            pdfium_lib: RwLock::new(None),
            manifest_seen: Mutex::new(None),
        }))
    }

    /// Where the shared TracePoint folder is: set by IT policy; else the
    /// one this PC joined; else found automatically (next to the exe, or the
    /// standard \\thor\Public\TP location) — then this PC joins it.
    fn find_team(config: &LocalConfig, exe_dir: Option<&Path>) -> TeamState {
        if let Some(p) = acl::policy_string("TeamFolder") {
            let ok = crate::team::is_setup(Path::new(&p));
            return TeamState { mode: if ok { "team" } else { "offline" }.into(), folder: Some(p), found_by: "policy".into(), available: None, forced: true };
        }
        if let Some(p) = &config.team_folder {
            let ok = crate::team::is_setup(Path::new(p));
            return TeamState { mode: if ok { "team" } else { "offline" }.into(), folder: Some(p.clone()), found_by: "joined".into(), available: None, forced: false };
        }
        let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(d) = exe_dir {
            candidates.push((d.join(TEAM_DIR_NAME), "next_to_exe"));
        }
        candidates.push((PathBuf::from(crate::team::DEFAULT_TEAM), "default"));
        for (p, how) in candidates {
            if crate::team::is_setup(&p) {
                // An existing setup: join it (nothing is copied from this PC).
                return TeamState { mode: "team".into(), folder: Some(p.display().to_string()), found_by: how.into(), available: None, forced: false };
            }
        }
        TeamState { mode: "standalone".into(), ..Default::default() }
    }

    fn team_dir(&self) -> Option<PathBuf> {
        let t = self.team.read().unwrap();
        (t.mode == "team").then(|| t.folder.as_ref().map(PathBuf::from)).flatten()
    }

    fn save_config(&self) -> Result<(), ApiError> {
        let cfg = self.config.read().unwrap().clone();
        self.guard.write(&self.paths.local.join("config.json"), serde_json::to_string_pretty(&cfg).unwrap().as_bytes())?;
        Ok(())
    }

    /// Others' rescans reach this PC without a restart: every few minutes,
    /// reload when the shared index list changed. Also re-reads roles.
    pub fn watch_team(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            let Some(me) = me.upgrade() else { return };
            // Offline at start: try again.
            {
                let t = me.team.read().unwrap().clone();
                if t.mode == "offline" && t.folder.as_deref().map(|f| crate::team::is_setup(Path::new(f))).unwrap_or(false) {
                    me.team.write().unwrap().mode = "team".into();
                    me.reload_roles();
                    me.load_index();
                    me.platform.emit("notice", json!({"text": "Connected to THOR again."}));
                    continue;
                }
            }
            if me.scan.lock().unwrap().running || me.content.lock().unwrap().running {
                continue;
            }
            let Some(t) = me.team_dir() else { continue };
            me.reload_roles();
            let stamp = std::fs::read(t.join("index").join("manifest.json")).ok().map(|b| sha2_hex(&b));
            if stamp.is_some() && *me.manifest_seen.lock().unwrap() != stamp {
                me.load_index();
                me.platform.emit("notice", json!({"text": "The shared index was updated — search now uses the latest scan."}));
            }
        });
    }

    fn reload_roles(&self) {
        let mut u = self.users.lock().unwrap();
        u.refresh();
        *self.session.lock().unwrap() = Some(u.session());
    }

    /// One rescan or publish at a time across the team: a lock file.
    fn take_scan_lock(&self) -> Result<Option<PathBuf>, String> {
        let Some(t) = self.team_dir() else { return Ok(None) };
        let lock = t.join("admin").join("scan.lock");
        if let Ok(b) = std::fs::read(&lock) {
            let v: Value = serde_json::from_slice(&b).unwrap_or(json!({}));
            let age = std::fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).map(|d| d.as_secs()).unwrap_or(0);
            if age < 6 * 3600 && v["machine"].as_str() != Some(self.platform.machine().as_str()) {
                return Err(format!(
                    "{} is already rescanning THOR from {} (started {}). Only one rescan runs at a time; everyone gets the result when it finishes.",
                    v["user"].as_str().unwrap_or("Someone"),
                    v["machine"].as_str().unwrap_or("another PC"),
                    v["started"].as_str().unwrap_or("recently")
                ));
            }
        }
        let body = json!({"user": self.me.account, "machine": self.platform.machine(), "started": auth::now()});
        self.guard.write(&lock, body.to_string().as_bytes()).map_err(|e| format!("Can't write to the shared folder: {e}"))?;
        Ok(Some(lock))
    }

    fn set_index_msg(&self, m: &str) {
        self.index_state.write().unwrap().message = m.to_string();
        self.platform.emit("index", json!({"message": m}));
    }

    /// This PC's own index (administrators and indexers): what rescans
    /// start from. Never shared as-is.
    fn master_path(&self) -> PathBuf {
        self.paths.local.join("index").join("thor_knowledge.db")
    }

    fn content_master_path(&self) -> PathBuf {
        self.paths.local.join("index").join("thor_content.db")
    }

    /// Your private folders' index and text: on this PC only, in your
    /// Windows profile (encrypted by Windows where EFS is allowed).
    fn private_dir(&self) -> PathBuf {
        self.paths.local.join("private")
    }

    pub fn private_allowed() -> bool {
        acl::policy_dword("DisablePrivateSources").map(|v| v == 0).unwrap_or(true)
    }

    fn private_index(&self) -> Option<PathBuf> {
        Some(self.private_dir().join("index.db")).filter(|p| Self::private_allowed() && p.is_file())
    }

    /// Load what this Windows account may see, plus your private folders.
    /// Runs on a background thread.
    pub fn load_index(self: &Arc<Self>) {
        let t0 = std::time::Instant::now();
        let team = self.team.read().unwrap().clone();
        let private = self.private_index();
        let mut parts: Vec<PathBuf> = Vec::new();
        let mut content: Vec<PathBuf> = Vec::new();
        let (source, kind) = match team.mode.as_str() {
            "offline" if private.is_none() => {
                self.fail_index(&format!(
                    "TracePoint can't reach THOR ({}). Check you're on the company network or VPN — it reconnects by itself, or restart TracePoint.",
                    team.folder.as_deref().unwrap_or("the shared folder")
                ));
                return;
            }
            "offline" => ("Your private folders (THOR not reachable)".to_string(), "private"),
            "team" => {
                let t = PathBuf::from(team.folder.clone().unwrap_or_default());
                self.set_index_msg("Checking which THOR folders your Windows account can open…");
                *self.manifest_seen.lock().unwrap() = std::fs::read(t.join("index").join("manifest.json")).ok().map(|b| sha2_hex(&b));
                let loaded = match crate::team::load_groups(&self.guard, &t, &self.paths.local.join("cache")) {
                    Ok(l) => l,
                    Err(e) => return self.fail_index(&e),
                };
                if loaded.parts.is_empty() && private.is_none() {
                    *self.groups.write().unwrap() = loaded.clone();
                    let msg = if loaded.open + loaded.locked + loaded.hidden + loaded.unavailable == 0 {
                        "No THOR index has been shared yet. An administrator or indexer can scan THOR under Sources."
                    } else if loaded.unavailable > 0 && loaded.locked + loaded.hidden == 0 {
                        "TracePoint can't reach THOR right now. Check you're on the company network or VPN."
                    } else {
                        "Your Windows account can't open any of the indexed THOR folders. If you should have access, ask IT."
                    };
                    return self.fail_index(msg);
                }
                parts.extend(loaded.parts.iter().cloned());
                content.extend(loaded.content.iter().cloned());
                *self.groups.write().unwrap() = loaded;
                (format!("Shared index ({})", t.display()), "team")
            }
            _ => {
                let p = self.master_path();
                if p.is_file() {
                    parts.push(p.clone());
                    let c = self.content_master_path();
                    if c.is_file() {
                        content.push(c);
                    }
                } else if private.is_none() {
                    return self.fail_index("No THOR index on this PC yet. Scan a THOR folder under Sources, or join your team's shared TracePoint folder.");
                }
                (format!("This PC ({})", p.display()), "local")
            }
        };
        if let Some(pv) = &private {
            parts.push(pv.clone());
            let pc = self.private_dir().join("content.db");
            if pc.is_file() {
                content.push(pc);
            }
        }
        self.set_index_msg("Reading the file records you can open…");
        let mem = match rusqlite::Connection::open_in_memory() {
            Ok(c) => c,
            Err(e) => return self.fail_index(&e.to_string()),
        };
        let _ = mem.pragma_update(None, "journal_mode", "OFF");
        if let Err(e) = crate::partition::merge_index(&parts, &mem) {
            return self.fail_index(&e);
        }
        let mut idx = match Index::load_conn(&mem) {
            Ok(i) => i,
            Err(e) => return self.fail_index(&e),
        };
        // Corrections administrators and indexers made, shared with everyone.
        let mut corrections: std::collections::HashMap<u32, Vec<crate::link::Correction>> = std::collections::HashMap::new();
        if let Ok(mut st) = mem.prepare("select file_id, kind, value, by from tp_corrections order by at, rowid") {
            let by_id: std::collections::HashMap<&str, u32> = idx.files.iter().enumerate().map(|(i, f)| (f.file_id.as_str(), i as u32)).collect();
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))) {
                for (fid, kind, value, by) in rows.flatten() {
                    if let Some(&fi) = by_id.get(fid.as_str()) {
                        corrections.entry(fi).or_default().push(crate::link::Correction { kind, value, by });
                    }
                }
            }
        }
        corrections = corrections.into_iter().map(|(k, v)| (k, crate::link::resolve(&v))).filter(|(_, v)| !v.is_empty()).collect();
        drop(mem);
        // Mark private files (their roots live only in the private index).
        if let Some(pv) = &private {
            let ids: std::collections::HashSet<String> = rusqlite::Connection::open_with_flags(pv, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .ok()
                .and_then(|c| c.prepare("select root_id from roots").ok().map(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect()).unwrap_or_default()))
                .unwrap_or_default();
            let private_roots: std::collections::HashSet<u16> = idx.roots.iter().enumerate().filter(|(_, r)| ids.contains(&r.root_id)).map(|(i, _)| i as u16).collect();
            for f in idx.files.iter_mut() {
                if private_roots.contains(&idx.dirs[f.dir as usize].root) {
                    f.flags |= crate::link::F_PRIVATE;
                }
            }
        }
        for r in &idx.roots {
            self.guard.protect(&r.path);
        }
        self.set_index_msg("Connecting copies, revisions and equipment…");
        let text = crate::engine::ContentIndex::open_many(&content, &idx);
        let cards = text.as_ref().map(|c| c.cards()).unwrap_or_default();
        let links = crate::link::apply(&mut idx, &cards, &corrections);
        self.set_index_msg("Building the search engine…");
        let mut engine = Engine::new(idx);
        engine.links = links;
        *engine.content.write().unwrap() = text;
        let n = engine.content.read().unwrap().as_ref().map(|c| c.files_read).unwrap_or(0);
        self.content.lock().unwrap().files_read_total = n;
        let files = engine.idx.files.len();
        let engine = Arc::new(engine);
        *self.engine.write().unwrap() = Some(engine.clone());
        // Learn nicknames in the background so the first search is instant.
        std::thread::spawn(move || {
            let _ = engine.has_nickname("");
        });
        *self.index_state.write().unwrap() = IndexState { ready: true, message: format!("{files} files ready in {:.1} s", t0.elapsed().as_secs_f64()), source, source_kind: kind.into(), error: None };
        self.platform.emit("index", json!({"ready": true}));
    }

    /// Scan your private folders (read-only), then read their contents.
    fn run_private_scan(self: Arc<Self>, roots: Vec<String>) {
        let dir = self.private_dir();
        if let Err(e) = self.guard.create_dir_all(&dir) {
            return self.scan_fail(&format!("Could not create {}: {e}", dir.display()));
        }
        // Encrypted by Windows for this account where IT allows EFS.
        let _ = acl::efs_encrypt(&dir);
        let mut c = match rusqlite::Connection::open(dir.join("index.db")) {
            Ok(c) => c,
            Err(e) => return self.scan_fail(&format!("Could not open your private index: {e}")),
        };
        let opts = crate::crawl::Options { workers: 4, cancel: self.scan_cancel.clone(), permissions: false };
        for root in &roots {
            self.scan_log(format!("Scanning your private folder {root} (read-only; only on this PC)…"));
            let me = self.clone();
            match crate::crawl::scan(&mut c, root, &opts, &|p| {
                let mut st = me.scan.lock().unwrap();
                st.phase = p.phase.to_string();
                st.files = p.files;
                st.dirs = p.dirs;
                st.new = p.new;
                st.changed = p.changed;
                st.missing = p.missing;
                let v = serde_json::to_value(&*st).unwrap();
                drop(st);
                me.platform.emit("scan", v);
            }) {
                Ok(s) => self.scan_log(format!("{root}: {} files · {} new · {} changed · {} missing", s.progress.files, s.progress.new, s.progress.changed, s.progress.missing)),
                Err(e) => {
                    drop(c);
                    return self.scan_fail(&e);
                }
            }
        }
        drop(c);
        {
            let mut st = self.scan.lock().unwrap();
            st.running = false;
            st.phase = "done".into();
            st.finished = Some(auth::now());
        }
        self.scan_log("Loading your private files into search…");
        self.load_index();
        self.scan_log("Done. Reading the contents of new and changed private files in the background…");
        let me = self.clone();
        std::thread::spawn(move || me.run_content_for(true));
    }

    fn private_roots(&self) -> Vec<Value> {
        let Some(p) = self.private_index() else { return vec![] };
        let Ok(c) = rusqlite::Connection::open_with_flags(&p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
        let Ok(mut st) = c.prepare(
            "select r.root_id, r.path, r.last_crawl_at, (select count(*) from files f where f.root_id=r.root_id and f.observation_state='current') from roots r order by r.path",
        ) else {
            return vec![];
        };
        st.query_map([], |r| Ok(json!({"root_id": r.get::<_, String>(0)?, "path": r.get::<_, String>(1)?, "last_scan": r.get::<_, Option<String>>(2)?, "files": r.get::<_, i64>(3)?})))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// The working copy an administrator scans into: their own, or — first
    /// time on this PC — built from the shared groups they can open.
    fn ensure_master(&self) -> Result<Option<PathBuf>, String> {
        let p = self.master_path();
        if p.is_file() {
            return Ok(Some(p));
        }
        let parts = self.groups.read().unwrap().parts.clone();
        if parts.is_empty() {
            return Ok(None);
        }
        self.guard.create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        let c = rusqlite::Connection::open(&p).map_err(|e| e.to_string())?;
        crate::partition::merge(&parts, &c)?;
        Ok(Some(p))
    }

    /// Same for document text.
    fn ensure_content_master(&self) -> PathBuf {
        let p = self.content_master_path();
        if !p.is_file() {
            if let Some(t) = self.team_dir() {
                let m = crate::team::read_manifest(&t).unwrap_or_default();
                let parts: Vec<PathBuf> = m
                    .groups
                    .iter()
                    .map(|g| t.join("index").join(&g.folder).join("content.db"))
                    .filter(|p| acl::can_open(p) == acl::Access::Allowed)
                    .collect();
                if !parts.is_empty() {
                    if let Ok(c) = rusqlite::Connection::open(&p) {
                        if crate::content::ensure_schema(&c).is_err() || crate::partition::merge(&parts, &c).is_err() {
                            drop(c);
                            let _ = self.guard.remove_own_file(&p);
                        }
                    }
                }
            }
        }
        p
    }

    /// Share this PC's index and document text with the team, split by who
    /// may read each file. Returns a one-line summary for the log.
    fn publish(&self) -> Result<String, String> {
        let Some(t) = self.team_dir() else { return Ok("This PC only — nothing to share.".into()) };
        let master = self.master_path();
        if !master.is_file() {
            return Err("Nothing to share yet.".into());
        }
        let _one = self.publishing.lock().unwrap_or_else(|p| p.into_inner());
        let held_lock = self.scan_lock.lock().unwrap().is_some();
        let lock = if held_lock { None } else { self.take_scan_lock()? };
        let content = self.content_master_path();
        let scratch = self.paths.local.join("publish");
        let log = |l: String| {
            if self.scan.lock().unwrap().running {
                self.scan_log(l);
            }
        };
        let res = crate::team::publish(&self.guard, &t, &self.me, &master, Some(content.as_path()).filter(|p| p.is_file()), &scratch, &log);
        if let Some(l) = lock {
            let _ = self.guard.remove_own_file(&l);
        }
        let rep = res?;
        let line = format!(
            "Shared {} files in {} permission groups{}{}{}.",
            rep.files,
            rep.groups,
            if rep.refused.is_empty() { String::new() } else { format!(" · {} groups held back (see Sources)", rep.refused.len()) },
            if rep.unreadable > 0 { format!(" · {} files left out (their permissions couldn't be read)", rep.unreadable) } else { String::new() },
            if rep.open_to_everyone > 0 { format!(" · {} groups are open to all staff", rep.open_to_everyone) } else { String::new() }
        );
        self.audit("index_shared", &line);
        *self.published.lock().unwrap() = Some(rep);
        Ok(line)
    }

    /// Publish, building this PC's working copy first if needed.
    fn share(&self) -> Result<String, String> {
        if self.ensure_master()?.is_none() {
            return Err("Nothing to share yet.".into());
        }
        self.publish()
    }

    fn attach_content(&self, engine: &Engine) {
        let paths: Vec<PathBuf> = match self.team_dir() {
            Some(_) => self.groups.read().unwrap().content.clone(),
            None => Some(self.content_master_path()).filter(|p| p.is_file()).into_iter().collect(),
        };
        *engine.content.write().unwrap() = crate::engine::ContentIndex::open_many(&paths, &engine.idx);
        let n = engine.content.read().unwrap().as_ref().map(|c| c.files_read).unwrap_or(0);
        self.content.lock().unwrap().files_read_total = n;
    }

    pub fn set_pdfium(&self, lib: PathBuf) {
        *self.pdfium_lib.write().unwrap() = Some(lib);
    }

    fn content_emit(&self) {
        let v = serde_json::to_value(&*self.content.lock().unwrap()).unwrap();
        self.platform.emit("content", v);
    }

    /// Read the text of new/changed documents, most valuable first, into a
    /// working copy of thor_content.db; publish it when done or stopped.
    pub fn run_content(self: Arc<Self>) {
        self.run_content_for(false)
    }

    /// Read document text: the shared (or this PC's) index, or — `private`
    /// — your private folders (kept apart, never shared).
    pub fn run_content_for(self: Arc<Self>, private: bool) {
        use crate::content::{self, Extractor};
        let Ok(e) = self.engine() else { return };
        {
            let mut st = self.content.lock().unwrap();
            if st.running {
                return;
            }
            let total_read = st.files_read_total;
            *st = ContentState { running: true, phase: "preparing".into(), started: Some(auth::now()), files_read_total: total_read, ..Default::default() };
        }
        self.content_cancel.store(false, Ordering::SeqCst);
        self.content_emit();
        let fail = |me: &Self, m: String| {
            let mut st = me.content.lock().unwrap();
            st.running = false;
            st.error = Some(m.clone());
            st.finished = Some(auth::now());
            drop(st);
            me.content_emit();
            me.audit("content_failed", &m);
        };
        let dir = if private { self.private_dir() } else { self.paths.local.join("index") };
        let active = if private { dir.join("content.db") } else { self.ensure_content_master() };
        let work = dir.join("content_work.db");
        if self.guard.create_dir_all(&dir).is_err() || self.guard.check(&work).is_err() {
            return fail(&self, "Can't write the content database.".into());
        }
        let _ = self.guard.remove_own_file(&work);
        if active.is_file() {
            if let Err(x) = self.guard.copy_into(&active, &work) {
                return fail(&self, format!("Could not copy the content database: {x}"));
            }
        }
        let c = match rusqlite::Connection::open(&work) {
            Ok(c) => c,
            Err(x) => return fail(&self, format!("Could not open the content database: {x}")),
        };
        let _ = c.pragma_update(None, "journal_mode", "MEMORY");
        let _ = c.pragma_update(None, "synchronous", "OFF");
        if let Err(x) = content::ensure_schema(&c) {
            return fail(&self, format!("Content database: {x}"));
        }
        // What's already been read, and is unchanged since.
        let mut known: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        if let Ok(mut st) = c.prepare("select file_id, size, mtime_ns from content_files") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))) {
                known.extend(rows.flatten());
            }
        }
        let mut carded: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(mut st) = c.prepare("select file_id from cards") {
            if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
                carded.extend(rows.flatten());
            }
        }
        let mut todo: Vec<(u32, f32)> = e
            .idx
            .files
            .iter()
            .enumerate()
            // Private files and shared files never mix in one text database.
            .filter(|(_, f)| (f.flags & crate::link::F_PRIVATE != 0) == private)
            .filter(|(_, f)| f.flags & crate::index::F_GONE == 0 && content::readable_ext(&f.ext) && f.size > 0 && (f.size as u64) <= content::MAX_FILE_BYTES)
            // New or changed, or read before fingerprint cards existed.
            .filter(|(_, f)| known.get(&f.file_id).map(|k| *k != (f.size, f.mtime)).unwrap_or(true) || !carded.contains(&f.file_id))
            .map(|(i, f)| (i as u32, content::value(f)))
            .filter(|x| x.1 > 0.0)
            .collect();
        todo.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(e.idx.files[b.0 as usize].year.cmp(&e.idx.files[a.0 as usize].year)));
        let ex = Extractor::new(self.pdfium_lib.read().unwrap().as_deref(), true);
        {
            let mut st = self.content.lock().unwrap();
            st.total = todo.len();
            st.phase = "reading".into();
            st.pdf_engine = ex.has_pdf();
            st.ocr_engine = ex.has_ocr();
            if !ex.has_pdf() {
                st.error = ex.pdfium_error.clone();
            }
        }
        self.content_emit();
        if !private {
            self.audit("content_started", &format!("{} documents to read", todo.len()));
        }

        // Readers fetch file bytes in parallel (read-only); one thread parses.
        let (tx, rx) = std::sync::mpsc::sync_channel::<(u32, f32, Result<Vec<u8>, String>)>(24);
        let cancel = self.content_cancel.clone();
        let paths: Vec<(u32, f32, String)> = todo.iter().map(|&(fi, v)| (fi, v, e.idx.full_path(fi))).collect();
        let reader = std::thread::spawn(move || {
            use rayon::prelude::*;
            let pool = rayon::ThreadPoolBuilder::new().num_threads(6).build().expect("pool");
            pool.install(|| {
                for chunk in paths.chunks(48) {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let got: Vec<_> = chunk
                        .par_iter()
                        .map(|(fi, v, p)| {
                            let path = crate::crawl::os_path(p);
                            // OneDrive "online-only" files: reading would download them.
                            if crate::acl::is_cloud_only(&path) {
                                return (*fi, *v, Err("online-only (not downloaded); skipped".to_string()));
                            }
                            (*fi, *v, std::fs::read(path).map_err(|x| x.to_string()))
                        })
                        .collect();
                    for g in got {
                        if tx.send(g).is_err() {
                            return;
                        }
                    }
                }
            });
        });
        let t0 = std::time::Instant::now();
        let mut last_emit = std::time::Instant::now();
        let mut last_commit = std::time::Instant::now();
        let now = auth::now();
        let _ = c.execute_batch("BEGIN");
        for (fi, value, bytes) in rx.iter() {
            if self.content_cancel.load(Ordering::Relaxed) {
                break;
            }
            let f = &e.idx.files[fi as usize];
            // Machine-named scans ("DOC123456.pdf") are exactly the files
            // whose contents must identify them: always OCR those.
            let machine_named = crate::crawl::classify_filename(&f.name) == "MACHINE_GENERATED";
            let budget = if value >= 0.3 || machine_named { 30 } else { 0 };
            let (x, card) = match bytes {
                Ok(b) => {
                    let sha = crate::card::sha256(&b);
                    let x = ex.extract(b, &f.ext, budget);
                    let card = crate::card::build(Some(sha), &x);
                    (x, Some(card))
                }
                Err(err) => (content::Extracted { error: Some(format!("Could not read: {err}")), ..Default::default() }, None),
            };
            let _ = content::save(&c, &f.file_id, &e.idx.full_path(fi), f.size, f.mtime, value, &x, card.as_ref(), &now);
            {
                let mut st = self.content.lock().unwrap();
                st.done += 1;
                st.pages += x.pages.len();
                st.ocr_pages += x.ocr_pages as usize;
                st.unreadable_pages += x.unreadable.len();
                if x.error.is_some() {
                    st.errors += 1;
                }
                if value >= 0.55 && x.error.is_none() {
                }
                st.current = Some(f.name.clone());
                let mins = t0.elapsed().as_secs_f64() / 60.0;
                st.files_per_min = st.done as f64 / mins.max(0.01);
                st.eta_min = Some((st.total - st.done) as f64 / st.files_per_min.max(0.1));
            }
            if last_commit.elapsed().as_secs() >= 20 {
                let _ = c.execute_batch("COMMIT; BEGIN");
                last_commit = std::time::Instant::now();
            }
            if last_emit.elapsed().as_millis() >= 500 {
                self.content_emit();
                last_emit = std::time::Instant::now();
            }
        }
        let stopped = self.content_cancel.load(Ordering::Relaxed);
        drop(rx);
        let _ = reader.join();
        let _ = c.execute_batch("COMMIT");
        drop(c);
        // Publish what was read (also when stopped: each file is complete).
        self.content.lock().unwrap().phase = "saving".into();
        self.content_emit();
        *e.content.write().unwrap() = None; // release the file before replacing it
        let local = if private { dir.join("content.db") } else { dir.join("thor_content.db") };
        let res = self.guard.publish(&work, &local);
        let _ = self.guard.remove_own_file(&work);
        if let Err(x) = res {
            self.attach_content(&e);
            return fail(&self, format!("Could not save the content database: {x}"));
        }
        if private {
            self.clone().load_index();
        } else if self.team_dir().is_some() {
            match self.share() {
                Ok(line) => self.audit("content_shared", &line),
                Err(x) => self.content.lock().unwrap().error = Some(format!("Saved on this PC, but couldn't share it: {x}")),
            }
            self.clone().load_index();
        } else {
            // Re-link with the new fingerprint cards.
            self.clone().load_index();
        }
        {
            let mut st = self.content.lock().unwrap();
            st.running = false;
            st.phase = if stopped { "stopped".into() } else { "done".into() };
            st.finished = Some(auth::now());
            st.current = None;
            st.eta_min = None;
        }
        self.content_emit();
        let st = self.content.lock().unwrap().clone();
        if private {
            return;
        }
        self.audit("content_finished", &format!("{} of {} documents read · {} pages · {} OCR pages{}", st.done, st.total, st.pages, st.ocr_pages, if stopped { " (stopped)" } else { "" }));
    }

    fn fail_index(&self, e: &str) {
        let mut st = self.index_state.write().unwrap();
        st.ready = false;
        st.error = Some(e.to_string());
        st.message = e.to_string();
        drop(st);
        self.platform.emit("index", json!({"error": e}));
    }

    /// The loaded search engine (tools and tests).
    pub fn current_engine(&self) -> Option<Arc<Engine>> {
        self.engine.read().unwrap().clone()
    }

    fn engine(&self) -> Result<Arc<Engine>, ApiError> {
        self.engine.read().unwrap().clone().ok_or_else(|| ApiError::new(503, "The THOR index is still loading."))
    }

    fn with_session<T>(&self, f: impl FnOnce(&Session) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let g = self.session.lock().unwrap();
        match g.as_ref() {
            Some(s) => f(s),
            None => Err(ApiError::new(401, "Windows didn't tell TracePoint who you are.")),
        }
    }

    fn require(&self, pred: impl FnOnce(&Session) -> bool, msg: &str) -> Result<(), ApiError> {
        self.with_session(|s| if pred(s) { Ok(()) } else { Err(ApiError::new(403, msg)) })
    }

    fn state(&self) -> Value {
        let sess = self.session.lock().unwrap();
        let users = self.users.lock().unwrap();
        let prefs: std::collections::HashMap<String, String> = users.prefs().into_iter().collect();
        drop(users);
        let idx = self.index_state.read().unwrap().clone();
        json!({
            "stage": "ready",
            "version": VERSION,
            "user": sess.as_ref().map(|s| &s.user),
            "index": idx,
            "team": *self.team.read().unwrap(),
            "prefs": prefs,
        })
    }

    fn file_path(&self, id: u32) -> Result<PathBuf, ApiError> {
        let e = self.engine()?;
        if id as usize >= e.idx.files.len() {
            return Err(ApiError::new(404, "No such file."));
        }
        Ok(crate::crawl::os_path(&e.idx.full_path(id)))
    }

    /// Re-open roles and settings for the current shared folder.
    fn reopen_users(&self) -> Result<(), ApiError> {
        let t = self.team.read().unwrap().clone();
        let team = match (&t.mode[..], &t.folder) {
            ("team" | "offline", Some(f)) => Some(PathBuf::from(f)),
            _ => None,
        };
        let u = UserStore::open(self.me.clone(), &self.paths.local, team.as_deref())?;
        *self.session.lock().unwrap() = Some(u.session());
        *self.users.lock().unwrap() = u;
        Ok(())
    }

    /// Join an existing shared setup, or (administrators) set one up.
    fn team_use(self: &Arc<Self>, path: PathBuf, create: bool) -> R {
        if self.team.read().unwrap().forced {
            return Err(ApiError::new(403, "Your IT department set the shared folder; it can't be changed here."));
        }
        self.guard.allow(&path)?;
        if crate::team::is_setup(&path) {
            // Join: nothing on this PC is copied there.
        } else if !create {
            return Err(ApiError::new(404, format!("There's no TracePoint setup in {}.", path.display())));
        } else {
            let is_admin = self.with_session(|s| Ok(s.is_admin()))?;
            if !is_admin {
                return Err(ApiError::new(403, "Only a TracePoint administrator can set up the shared folder."));
            }
            let me = self.me.clone();
            let mut users = self.users.lock().unwrap();
            let mut found = |m: auth::Member| users.found_team(path.join("roles.json"), path.join("admin").join("activity.db"), m).map_err(|e| e.0);
            crate::team::setup(&self.guard, &path, &me, &mut found).map_err(|e| ApiError::new(400, e))?;
            drop(users);
        }
        {
            let mut cfg = self.config.write().unwrap();
            cfg.team_folder = Some(path.display().to_string());
        }
        self.save_config()?;
        *self.team.write().unwrap() = TeamState { mode: "team".into(), folder: Some(path.display().to_string()), found_by: "joined".into(), available: None, forced: false };
        self.reopen_users()?;
        let is_admin = self.with_session(|s| Ok(s.is_admin()))?;
        let legacy = if is_admin { crate::team::remove_legacy(&self.guard, &path) } else { vec![] };
        if !legacy.is_empty() {
            self.audit("legacy_removed", &legacy.join(", "));
        }
        let mut shared = None;
        if create && self.master_path().is_file() {
            shared = Some(self.publish().unwrap_or_else(|e| format!("Not shared yet: {e}")));
        }
        self.audit("team_folder_joined", &path.display().to_string());
        let me = self.clone();
        std::thread::spawn(move || me.load_index());
        Ok(json!({"team": *self.team.read().unwrap(), "shared": shared, "removed_legacy": legacy}))
    }

    /// Handle one command. `cmd` is a dotted name, `a` its JSON arguments.
    pub fn handle(self: &Arc<Self>, cmd: &str, a: &Value) -> R {
        match cmd {
            // ── Session ──────────────────────────────────────────────
            "state" => Ok(self.state()),
            "auth.set_pref" => {
                let k = s(a, "key");
                if !["open_mode", "density", "results_view", "home_hint"].contains(&k.as_str()) {
                    return Err(ApiError::new(400, "Unknown preference."));
                }
                self.users.lock().unwrap().set_pref(&k, &s(a, "value"))?;
                Ok(json!({"ok": true}))
            }
            "connection.retry" => {
                let cfg = self.config.read().unwrap().clone();
                let t = Self::find_team(&cfg, self.exe_dir.as_deref());
                if let Some(f) = &t.folder {
                    self.guard.allow(Path::new(f))?;
                }
                let ok = t.mode != "offline";
                *self.team.write().unwrap() = t;
                self.reopen_users()?;
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"connected": ok}))
            }

            // ── Search ───────────────────────────────────────────────
            "search" => {
                self.with_session(|_| Ok(()))?;
                let req: SearchRequest = arg(a)?;
                Ok(serde_json::to_value(self.engine()?.search(&req)).unwrap())
            }
            "suggest" => {
                self.with_session(|_| Ok(()))?;
                Ok(serde_json::to_value(self.engine()?.suggest(&s(a, "q"), 8)).unwrap())
            }
            "equipment.card" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as usize;
                if id >= e.idx.equipment.len() {
                    return Err(ApiError::new(404, "No such equipment."));
                }
                Ok(serde_json::to_value(e.equipment_card(id as u32)).unwrap())
            }
            "equipment.list" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let q = s(a, "q").to_lowercase();
                let unit = s(a, "unit");
                let mut list: Vec<Value> = e
                    .idx
                    .equipment
                    .iter()
                    .enumerate()
                    .filter(|(_, x)| x.file_count > 0)
                    .filter(|(_, x)| unit.is_empty() || x.unit.map(|u| e.idx.units[u as usize].label == unit).unwrap_or(false))
                    .filter(|(_, x)| {
                        q.is_empty()
                            || x.number.to_lowercase().contains(&q)
                            || x.description.to_lowercase().contains(&q)
                            || x.tags.iter().any(|t| t.to_lowercase().replace('-', "").contains(&q.replace('-', "")))
                            || x.kind.to_lowercase().contains(&q)
                    })
                    .map(|(i, x)| {
                        json!({"id": i, "number": x.number, "tags": x.tags, "description": x.description, "kind": x.kind,
                               "unit": x.unit.map(|u| e.idx.units[u as usize].label.clone()), "files": x.file_count,
                               "historical": x.historical})
                    })
                    .collect();
                list.sort_by(|x, y| x["number"].as_str().cmp(&y["number"].as_str()));
                let units: Vec<Value> = e.idx.units.iter().map(|u| json!({"label": u.label, "code": u.code, "name": u.name})).collect();
                Ok(json!({"equipment": list, "units": units}))
            }
            "graph.walk" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("root");
                let depth = a.get("depth").and_then(|x| x.as_u64()).unwrap_or(1) as usize;
                let v = crate::graph::walk(&e, id, depth);
                if v.get("error").is_some() {
                    return Err(ApiError::new(404, "That item is no longer in the index."));
                }
                Ok(v)
            }
            "graph.equipment" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as usize;
                if id >= e.idx.equipment.len() {
                    return Err(ApiError::new(404, "No such equipment."));
                }
                Ok(crate::graph::equipment_graph(&e, id as u32))
            }
            "file.info" => {
                self.with_session(|_| Ok(()))?;
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as u32;
                if id as usize >= e.idx.files.len() {
                    return Err(ApiError::new(404, "No such file."));
                }
                let f = &e.idx.files[id as usize];
                let family = f.family.map(|fa| {
                    let fam = &e.idx.families[fa as usize];
                    let mut members: Vec<Value> = fam
                        .members
                        .iter()
                        .map(|&m| {
                            let mf = &e.idx.files[m as usize];
                            json!({"id": m, "name": mf.name, "sheet": mf.sheet, "rev": mf.rev, "latest": mf.flags & crate::index::F_LATEST != 0})
                        })
                        .collect();
                    members.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
                    json!({"base": fam.base, "kind": fam.kind, "members": members})
                });
                let siblings = e.idx.files.iter().filter(|x| x.dir == f.dir).count();
                Ok(json!({"hit": e.hit(id, 0, 0, vec![]), "family": family, "folder_files": siblings}))
            }
            "file.open" => {
                self.with_session(|_| Ok(()))?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as u32;
                let path = self.file_path(id)?;
                let mode = s(a, "mode");
                if mode == "original" {
                    self.platform.open_path(&path).map_err(|e| ApiError::new(500, e))?;
                } else {
                    // Default: open a temporary read-only copy so nothing can be
                    // saved back to THOR by accident.
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
                    let dir = self.paths.temp.join("open").join(format!("{id}"));
                    let dest = dir.join(&name);
                    self.guard.copy_into(&path, &dest).map_err(|e| ApiError::new(500, format!("Could not copy the file for viewing: {e}")))?;
                    if let Ok(meta) = std::fs::metadata(&dest) {
                        let mut p = meta.permissions();
                        p.set_readonly(true);
                        let _ = std::fs::set_permissions(&dest, p);
                    }
                    self.platform.open_path(&dest).map_err(|e| ApiError::new(500, e))?;
                }
                Ok(json!({"ok": true}))
            }
            "file.reachable" => {
                self.with_session(|_| Ok(()))?;
                let path = self.file_path(a["id"].as_u64().unwrap_or(u64::MAX) as u32)?;
                let meta = std::fs::metadata(&path).ok();
                Ok(json!({"ok": meta.is_some(), "size": meta.map(|m| m.len())}))
            }
            "file.reveal" => {
                self.with_session(|_| Ok(()))?;
                let path = self.file_path(a["id"].as_u64().unwrap_or(u64::MAX) as u32)?;
                self.platform.reveal(&path).map_err(|e| ApiError::new(500, e))?;
                Ok(json!({"ok": true}))
            }
            "export.xlsx" => {
                self.with_session(|_| Ok(()))?;
                let mut req: SearchRequest = arg(&a["request"])?;
                req.limit = 5000;
                req.offset = 0;
                let e = self.engine()?;
                let resp = e.search(&req);
                let name = format!("TracePoint_Results_{}.xlsx", auth::now().replace([':', '-'], "").replace('T', "_").trim_end_matches('Z'));
                let Some(dest) = self.platform.save_dialog("Export search results", &name, "xlsx") else {
                    return Ok(json!({"cancelled": true}));
                };
                self.guard.check(&dest)?;
                let filters = format!("{:?} {:?} {:?}", req.categories, req.units, req.exts);
                let source = self.index_state.read().unwrap().source.clone();
                crate::export::write_xlsx(&dest, &resp.hits, &req.query, &filters, &source).map_err(|e| ApiError::new(500, e))?;
                Ok(json!({"path": dest.display().to_string(), "rows": resp.hits.len()}))
            }

            // ── Index and sources ────────────────────────────────────
            "index.status" => {
                let can_rescan = self.with_session(|s| Ok(s.user.role.can_rescan()))?;
                let st = self.index_state.read().unwrap().clone();
                let e = self.engine.read().unwrap().clone();
                let (roots, stats, generated) = match &e {
                    Some(e) => {
                        let mut by_cat: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
                        for f in &e.idx.files {
                            *by_cat.entry(f.cat.label()).or_default() += 1;
                        }
                        (
                            serde_json::to_value(&e.idx.roots).unwrap(),
                            json!({
                                "files": e.idx.files.len(), "folders": e.idx.dirs.len(), "equipment": e.idx.equipment.iter().filter(|x| x.file_count > 0).count(),
                                "units": e.idx.units.len(), "families": e.idx.families.len(), "load_ms": e.idx.load_ms,
                                "with_equipment": e.idx.files.iter().filter(|f| !f.equip.is_empty()).count(),
                                "categories": by_cat,
                            }),
                            e.idx.generated_at.clone(),
                        )
                    }
                    None => (json!([]), json!({}), None),
                };
                Ok(json!({"state": st, "roots": roots, "stats": stats, "generated_at": generated, "protected": self.guard.protected_roots(),
                          "writable": self.guard.writable_dirs(), "team": *self.team.read().unwrap(), "groups": *self.groups.read().unwrap(),
                          "published": if can_rescan { serde_json::to_value(&*self.published.lock().unwrap()).unwrap() } else { Value::Null },
                          "exe_dir": self.exe_dir.as_ref().map(|d| d.display().to_string()), "default_team": crate::team::DEFAULT_TEAM}))
            }
            "index.reload" => {
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"started": true}))
            }
            "index.share" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can share the index.")?;
                let line = self.share().map_err(|e| ApiError::new(400, e))?;
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"message": line, "report": *self.published.lock().unwrap()}))
            }
            "index.import" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can import an index.")?;
                let Some(src) = self.platform.open_dialog("Choose a THOR knowledge database (thor_knowledge.db)", "db") else {
                    return Ok(json!({"cancelled": true}));
                };
                // Validate before copying.
                Index::load(&src).map_err(|e| ApiError::new(400, format!("That file can't be used: {e}")))?;
                let dest = self.master_path();
                self.guard.copy_into(&src, &dest)?;
                self.audit("index_imported", &src.display().to_string());
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                let note = if self.team_dir().is_some() {
                    "Imported to this PC. Run a rescan next: TracePoint reads each file's Windows permissions during the scan, and only then shares it with the team."
                } else {
                    "Imported. Search is loading it now."
                };
                Ok(json!({"imported": dest.display().to_string(), "message": note}))
            }

            // ── Connections and cleanup ──────────────────────────────
            "links.status" => {
                let e = self.engine()?;
                Ok(serde_json::to_value(&e.links.stats).unwrap())
            }
            "report.cleanup" => {
                self.require(|s| s.user.role.can_rescan(), "The cleanup report is for administrators and indexers.")?;
                let e = self.engine()?;
                let name = format!("TracePoint_Cleanup_{}.xlsx", auth::now()[..10].replace('-', ""));
                let Some(dest) = self.platform.save_dialog("Save the cleanup report", &name, "xlsx") else {
                    return Ok(json!({"cancelled": true}));
                };
                self.guard.check(&dest)?;
                let rows = self.cleanup_rows(&e);
                let source = self.index_state.read().unwrap().source.clone();
                crate::export::write_cleanup(&dest, &rows.iter().map(|(a, b, r)| (*a, *b, r.clone_rows())).collect::<Vec<_>>(), &source).map_err(|x| ApiError::new(500, x))?;
                self.audit("cleanup_report", &format!("{} rows", rows.iter().map(|x| x.2.len()).sum::<usize>()));
                Ok(json!({"path": dest.display().to_string(), "rows": rows.iter().map(|x| x.2.len()).sum::<usize>()}))
            }

            "file.correct" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can correct the index.")?;
                let kind = s(a, "kind");
                if !["equip", "not_equip", "current", "superseded", "clear"].contains(&kind.as_str()) {
                    return Err(ApiError::new(400, "Unknown correction."));
                }
                let e = self.engine()?;
                let id = a["id"].as_u64().unwrap_or(u64::MAX) as usize;
                let f = e.idx.files.get(id).ok_or_else(|| ApiError::new(404, "No such file."))?;
                // The index may have reloaded since the search: make sure it's the same file.
                if a.get("name").and_then(|x| x.as_str()).map(|n| n != f.name).unwrap_or(false) {
                    return Err(ApiError::new(409, "The index just updated — search again, then make the correction."));
                }
                if f.flags & crate::link::F_PRIVATE != 0 {
                    return Err(ApiError::new(400, "That's a private file — corrections are for the shared index."));
                }
                let mut value = s(a, "value").trim().to_string();
                if kind == "equip" || kind == "not_equip" {
                    let ok = e.idx.equipment.iter().find(|q| q.number.eq_ignore_ascii_case(&value)).map(|q| q.number.clone());
                    value = ok.ok_or_else(|| ApiError::new(400, format!("No equipment numbered {value}.")))?;
                }
                let file_id = f.file_id.clone();
                let master = self.ensure_master().map_err(|x| ApiError::new(500, x))?.ok_or_else(|| ApiError::new(400, "No index on this PC to correct yet."))?;
                {
                    let c = rusqlite::Connection::open(&master).map_err(|x| ApiError::new(500, x.to_string()))?;
                    // A dated entry; the latest word wins when the log is read.
                    c.execute_batch(crate::link::CORRECTIONS_SQL).map_err(|x| ApiError::new(500, x.to_string()))?;
                    c.execute("INSERT OR REPLACE INTO tp_corrections VALUES(?1,?2,?3,?4,?5)", rusqlite::params![file_id, kind, value, self.me.account, auth::now()]).map_err(|x| ApiError::new(500, x.to_string()))?;
                }
                self.audit("index_corrected", &format!("{} — {kind} {value}", f.name));
                let me = self.clone();
                std::thread::spawn(move || {
                    if me.team_dir().is_some() {
                        let _ = me.publish();
                    }
                    me.load_index();
                });
                Ok(json!({"ok": true, "message": if self.team_dir().is_some() { "Saved. Sharing it with everyone now." } else { "Saved." }}))
            }

            // ── Private folders (this PC, this person only) ──────────
            "private.status" => {
                let dir = self.private_dir();
                Ok(json!({"allowed": Self::private_allowed(), "roots": self.private_roots(), "encrypted": acl::is_encrypted(&dir),
                          "files": self.engine.read().unwrap().as_ref().map(|e| e.idx.files.iter().filter(|f| f.flags & crate::link::F_PRIVATE != 0).count()).unwrap_or(0)}))
            }
            "private.add" | "private.rescan" => {
                if !Self::private_allowed() {
                    return Err(ApiError::new(403, "Private folders are switched off on this PC by your IT department."));
                }
                if self.scan.lock().unwrap().running {
                    return Err(ApiError::new(409, "A scan is already running."));
                }
                let mut roots: Vec<String> = Vec::new();
                if cmd == "private.add" {
                    let p = match self.platform.pick_folder("Choose a folder to search privately (only you, on this PC)") {
                        Some(p) => p,
                        None => return Ok(json!({"cancelled": true})),
                    };
                    // Windows-style paths everywhere (dev hosts map them back).
                    let ps = if cfg!(windows) { p.display().to_string() } else { p.display().to_string().replace('/', "\\") };
                    let n = crate::guard::normalize(&ps);
                    if self.team.read().unwrap().folder.as_deref().map(|t| n.starts_with(&crate::guard::normalize(t))).unwrap_or(false) || n.starts_with(&crate::guard::normalize(&self.paths.local.display().to_string())) {
                        return Err(ApiError::new(400, "That's one of TracePoint's own folders."));
                    }
                    if n.starts_with("\\\\") {
                        return Err(ApiError::new(400, "Private folders are for this PC (Documents, Downloads, a local or USB drive). Network shares belong in the shared index, where Windows permissions decide who sees them."));
                    }
                    roots.push(ps);
                } else {
                    roots.extend(self.private_roots().iter().filter_map(|r| r["path"].as_str().map(str::to_string)));
                }
                if roots.is_empty() {
                    return Err(ApiError::new(400, "No private folders yet."));
                }
                for r in &roots {
                    self.guard.protect(r);
                }
                self.scan_cancel.store(false, Ordering::SeqCst);
                *self.scan.lock().unwrap() = ScanState { running: true, root: Some(roots.join(", ")), phase: "starting".into(), started: Some(auth::now()), ..Default::default() };
                let me = self.clone();
                std::thread::spawn(move || me.run_private_scan(roots));
                Ok(serde_json::to_value(&*self.scan.lock().unwrap()).unwrap())
            }
            "private.remove" => {
                let rid = s(a, "root_id");
                let dir = self.private_dir();
                let idxp = dir.join("index.db");
                if let Ok(c) = rusqlite::Connection::open(&idxp) {
                    let ids: Vec<String> = c.prepare("select file_id from files where root_id=?1").and_then(|mut st| st.query_map([&rid], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect())).unwrap_or_default();
                    let _ = c.execute_batch("begin");
                    for t in ["files", "crawls", "roots", "identifiers", "issues", "patterns"] {
                        let _ = c.execute(&format!("delete from {t} where root_id=?1"), [&rid]);
                    }
                    let _ = c.execute_batch("commit");
                    if let Ok(cc) = rusqlite::Connection::open(dir.join("content.db")) {
                        let _ = cc.execute_batch("begin");
                        for id in &ids {
                            for t in ["content_files", "content_fts", "cards"] {
                                let _ = cc.execute(&format!("delete from {t} where file_id=?1"), [id]);
                            }
                        }
                        let _ = cc.execute_batch("commit");
                    }
                }
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"ok": true}))
            }

            // ── Shared folder ────────────────────────────────────────
            "team.status" => {
                let t = self.team.read().unwrap().clone();
                let found = [self.exe_dir.as_ref().map(|d| d.join(TEAM_DIR_NAME)), Some(PathBuf::from(crate::team::DEFAULT_TEAM))]
                    .into_iter()
                    .flatten()
                    .find(|p| crate::team::is_setup(p))
                    .map(|p| p.display().to_string());
                Ok(json!({"team": t, "found": found, "default": crate::team::DEFAULT_TEAM,
                          "next_to_exe": self.exe_dir.as_ref().map(|d| d.join(TEAM_DIR_NAME).display().to_string())}))
            }
            "team.join" | "team.setup" => {
                let path = if a.get("pick").and_then(|x| x.as_bool()).unwrap_or(false) {
                    match self.platform.pick_folder("Choose the shared TracePoint folder") {
                        Some(p) => p,
                        None => return Ok(json!({"cancelled": true})),
                    }
                } else if a.get("next_to_exe").and_then(|x| x.as_bool()).unwrap_or(false) {
                    self.exe_dir.as_ref().map(|d| d.join(TEAM_DIR_NAME)).ok_or_else(|| ApiError::new(400, "Can't tell where TracePoint.exe is."))?
                } else {
                    let p = s(a, "path");
                    PathBuf::from(if p.trim().is_empty() { crate::team::DEFAULT_TEAM.to_string() } else { p.trim().to_string() })
                };
                self.team_use(path, cmd == "team.setup")
            }
            "team.leave" => {
                if self.team.read().unwrap().forced {
                    return Err(ApiError::new(403, "Your IT department set the shared folder; it can't be changed here."));
                }
                self.config.write().unwrap().team_folder = None;
                self.save_config()?;
                *self.team.write().unwrap() = TeamState { mode: "standalone".into(), ..Default::default() };
                self.reopen_users()?;
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"ok": true}))
            }

            // ── Administration ───────────────────────────────────────
            "admin.members" => {
                self.require(|s| s.is_admin(), "Administrators only.")?;
                let mut u = self.users.lock().unwrap();
                u.refresh();
                Ok(json!({"members": u.list(), "roles_file": u.roster_path().display().to_string(), "me": self.me.sid}))
            }
            "admin.member.set" => {
                self.require(|s| s.is_admin(), "Administrators only.")?;
                let role = Role::parse(&s(a, "role")).ok_or_else(|| ApiError::new(400, "Choose a role."))?;
                let who = if let Some(sid) = a.get("sid").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
                    let account = self.users.lock().unwrap().list().into_iter().find(|m| m.sid == sid).map(|m| m.account).unwrap_or_else(|| sid.to_string());
                    acl::Identity::new(sid, &account, &account)
                } else {
                    let name = s(a, "account").trim().to_string();
                    match acl::lookup_account(&name) {
                        Ok(id) => id,
                        // Cloud-joined PCs often can't look up domain accounts:
                        // keep the DOMAIN\user name; roles match on it.
                        Err(_) if name.contains('\\') && !name.ends_with('\\') && !name.contains(' ') => {
                            acl::Identity::new(&format!("account:{}", name.to_lowercase()), &name, name.rsplit('\\').next().unwrap_or(&name))
                        }
                        Err(e) => return Err(ApiError::new(400, e)),
                    }
                };
                let mut u = self.users.lock().unwrap();
                u.set_member(&who, role)?;
                let roster = u.roster().clone();
                drop(u);
                // Windows enforces it: writers of the shared folder are exactly
                // the administrators and indexers.
                let warning = match self.team_dir() {
                    Some(t) => crate::team::apply_locks(&t, &roster).err().map(|e| format!("Role saved, but the shared folder's Windows permissions couldn't be updated: {e}")),
                    None => None,
                };
                self.reload_roles();
                Ok(json!({"ok": true, "warning": warning, "account": who.account}))
            }
            "admin.audit" => {
                self.require(|s| s.is_admin(), "Administrators only.")?;
                let rows = self.users.lock().unwrap().audit_log(500)?;
                Ok(Value::Array(rows.into_iter().map(|r| json!({"at": r.0, "actor": r.1, "action": r.2, "detail": r.3, "machine": r.4})).collect()))
            }

            // ── About / for IT ───────────────────────────────────────
            "about" => Ok(self.about()),
            "indexer.status" => {
                self.with_session(|_| Ok(()))?;
                Ok(serde_json::to_value(&*self.scan.lock().unwrap()).unwrap())
            }
            "indexer.start" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can rescan THOR.")?;
                if self.scan.lock().unwrap().running {
                    return Err(ApiError::new(409, "A scan is already running."));
                }
                let mut roots: Vec<String> = Vec::new();
                if a.get("pick").and_then(|x| x.as_bool()).unwrap_or(false) {
                    match self.platform.pick_folder("Choose a THOR folder to add to the index") {
                        Some(p) => roots.push(p.display().to_string()),
                        None => return Ok(json!({"cancelled": true})),
                    }
                } else if let Some(r) = a.get("root").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
                    roots.push(r.to_string());
                } else if let Some(e) = self.engine.read().unwrap().clone() {
                    roots.extend(e.idx.roots.iter().filter(|r| r.enabled).map(|r| r.path.clone()));
                }
                if roots.is_empty() {
                    return Err(ApiError::new(400, "No THOR folder to scan. Add one first."));
                }
                for r in &roots {
                    // A source is read-only from now on, and can't be one of our own folders.
                    if self.guard.check(Path::new(r)).is_ok() && self.guard.writable_dirs().iter().any(|w| crate::guard::normalize(r).starts_with(&crate::guard::normalize(w))) {
                        return Err(ApiError::new(400, "That folder is one of TracePoint's own folders, not a THOR source."));
                    }
                    self.guard.protect(r);
                }
                let workers = a.get("workers").and_then(|x| x.as_u64()).unwrap_or(8) as usize;
                let lock = self.take_scan_lock().map_err(|m| ApiError::new(409, m))?;
                *self.scan_lock.lock().unwrap() = lock;
                self.scan_cancel.store(false, Ordering::SeqCst);
                *self.scan.lock().unwrap() = ScanState { running: true, root: Some(roots.join(", ")), phase: "starting".into(), started: Some(auth::now()), ..Default::default() };
                self.audit("rescan_started", &roots.join(", "));
                let me = self.clone();
                std::thread::spawn(move || me.run_scan(roots, workers));
                Ok(serde_json::to_value(&*self.scan.lock().unwrap()).unwrap())
            }
            "content.status" => {
                self.with_session(|_| Ok(()))?;
                Ok(serde_json::to_value(&*self.content.lock().unwrap()).unwrap())
            }
            "content.start" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can read document contents.")?;
                if self.content.lock().unwrap().running {
                    return Err(ApiError::new(409, "Already reading documents."));
                }
                self.engine()?;
                let me = self.clone();
                std::thread::spawn(move || me.run_content());
                Ok(json!({"started": true}))
            }
            "content.stop" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can stop this.")?;
                self.content_cancel.store(true, Ordering::SeqCst);
                Ok(json!({"stopping": true}))
            }
            "indexer.stop" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can stop a scan.")?;
                self.scan_cancel.store(true, Ordering::SeqCst);
                Ok(json!({"stopping": true}))
            }
            _ => Err(ApiError::new(404, format!("Unknown command {cmd}"))),
        }
    }

    fn scan_log(&self, line: impl Into<String>) {
        let mut st = self.scan.lock().unwrap();
        st.log.push(line.into());
        let v = serde_json::to_value(&*st).unwrap();
        drop(st);
        self.platform.emit("scan", v);
    }

    fn scan_fail(&self, e: &str) {
        let mut st = self.scan.lock().unwrap();
        st.running = false;
        st.error = Some(e.to_string());
        st.finished = Some(auth::now());
        st.log.push(e.to_string());
        let v = serde_json::to_value(&*st).unwrap();
        drop(st);
        self.platform.emit("scan", v);
        self.audit("rescan_failed", e);
    }

    /// Rescan on a working copy, then swap the new index in and publish it.
    /// THOR is only read. Search keeps working on the old index meanwhile.
    fn run_scan(self: Arc<Self>, roots: Vec<String>, workers: usize) {
        self.clone().run_scan_inner(roots, workers);
        if let Some(l) = self.scan_lock.lock().unwrap().take() {
            let _ = self.guard.remove_own_file(&l);
        }
    }

    fn run_scan_inner(self: Arc<Self>, roots: Vec<String>, workers: usize) {
        let dir = self.paths.local.join("index");
        let work = dir.join("work.db");
        if let Err(e) = self.guard.create_dir_all(&dir) {
            return self.scan_fail(&format!("Could not create {}: {e}", dir.display()));
        }
        let _ = self.guard.remove_own_file(&work);
        match self.ensure_master() {
            Ok(Some(src)) => {
                self.scan_log("Copying the current index to a working copy…");
                if let Err(e) = self.guard.copy_into(&src, &work) {
                    return self.scan_fail(&format!("Could not copy the index: {e}"));
                }
            }
            Ok(None) => {}
            Err(e) => return self.scan_fail(&format!("Could not prepare the index: {e}")),
        }
        if let Err(e) = self.guard.check(&work) {
            return self.scan_fail(&e.to_string());
        }
        let mut c = match rusqlite::Connection::open(&work) {
            Ok(c) => c,
            Err(e) => return self.scan_fail(&format!("Could not open the working index: {e}")),
        };
        // A scratch copy: speed over durability (it is discarded on failure).
        let _ = c.pragma_update(None, "journal_mode", "MEMORY");
        let _ = c.pragma_update(None, "synchronous", "OFF");
        let opts = crate::crawl::Options { workers, cancel: self.scan_cancel.clone(), permissions: true };
        let mut total = crate::crawl::Progress::default();
        for root in &roots {
            self.scan_log(format!("Scanning {root} with {workers} parallel readers (read-only; names, dates, sizes and Windows permissions)…"));
            let me = self.clone();
            let last = std::cell::Cell::new(std::time::Instant::now());
            let res = crate::crawl::scan(&mut c, root, &opts, &|p| {
                if last.get().elapsed().as_millis() < 400 && p.phase == "scanning" {
                    return;
                }
                last.set(std::time::Instant::now());
                let mut st = me.scan.lock().unwrap();
                st.phase = p.phase.to_string();
                st.files = total.files + p.files;
                st.dirs = total.dirs + p.dirs;
                st.new = total.new + p.new;
                st.changed = total.changed + p.changed;
                st.missing = total.missing + p.missing;
                st.errors = total.issues + p.issues;
                st.files_per_sec = p.files_per_sec;
                let v = serde_json::to_value(&*st).unwrap();
                drop(st);
                me.platform.emit("scan", v);
            });
            match res {
                Ok(s) => {
                    let p = &s.progress;
                    self.scan_log(format!(
                        "{root}: {} files in {} folders · {} new · {} changed · {} missing · {} issues · {:.0} s ({:.0} files/s) · {}",
                        p.files, p.dirs, p.new, p.changed, p.missing, p.issues, p.elapsed_s, p.files_per_sec, s.status
                    ));
                    total.files += p.files;
                    total.dirs += p.dirs;
                    total.new += p.new;
                    total.changed += p.changed;
                    total.missing += p.missing;
                    total.issues += p.issues;
                    if s.status == "interrupted" {
                        drop(c);
                        let _ = self.guard.remove_own_file(&work);
                        let mut st = self.scan.lock().unwrap();
                        st.running = false;
                        st.phase = "stopped".into();
                        st.finished = Some(auth::now());
                        st.error = Some("Stopped — the index was not changed".into());
                        let v = serde_json::to_value(&*st).unwrap();
                        drop(st);
                        self.platform.emit("scan", v);
                        self.audit("rescan_stopped", &roots.join(", "));
                        return;
                    }
                }
                Err(e) => {
                    drop(c);
                    let _ = self.guard.remove_own_file(&work);
                    return self.scan_fail(&e);
                }
            }
        }
        drop(c);
        // Swap in locally, then publish to the team folder for everyone else.
        self.scan_log("Saving the new index…");
        let local = dir.join("thor_knowledge.db");
        if let Err(e) = self.guard.publish(&work, &local) {
            return self.scan_fail(&format!("Could not save the new index: {e}"));
        }
        let _ = self.guard.remove_own_file(&work);
        if self.team_dir().is_some() {
            self.scan_log("Sharing with the team: one locked index file per set of Windows permissions…");
            match self.publish() {
                Ok(line) => self.scan_log(line),
                Err(e) => self.scan_log(format!("Not shared ({e}). This PC keeps the new index; nobody else sees it yet.")),
            }
        }
        {
            let mut st = self.scan.lock().unwrap();
            st.running = false;
            st.phase = "done".into();
            st.finished = Some(auth::now());
            st.files = total.files;
            st.dirs = total.dirs;
            st.new = total.new;
            st.changed = total.changed;
            st.missing = total.missing;
            st.errors = total.issues;
        }
        self.audit("rescan_finished", &format!("{} files · {} new · {} changed · {} missing", total.files, total.new, total.changed, total.missing));
        self.scan_log("Loading the new index into search…");
        self.load_index();
        self.scan_log("Done. Search is using the new index.");
        // Then read what's new or changed inside documents (free, local).
        self.scan_log("Reading the contents of new and changed documents in the background…");
        let me = self.clone();
        std::thread::spawn(move || me.run_content());
    }

    /// Activity log (administrators' and indexers' actions only; searches
    /// are never logged).
    fn audit(&self, action: &str, detail: &str) {
        let _ = self.users.lock().unwrap().audit(action, detail);
    }

    /// Bytes for the preview pane: the file itself, a PNG of a TIFF's first
    /// page, or the first 256 KB of a text file. Read-only.
    pub fn serve_file(&self, id: u32, as_: &str) -> Result<(String, Vec<u8>), ApiError> {
        self.with_session(|_| Ok(()))?;
        let path = self.file_path(id)?;
        let meta = std::fs::metadata(&path).map_err(|_| ApiError::new(404, "File not reachable"))?;
        if meta.len() > 300 * 1024 * 1024 {
            return Err(ApiError::new(413, "Too large to preview"));
        }
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        match as_ {
            "png" => {
                let img = image::open(&path).map_err(|e| ApiError::new(415, format!("Can't render this image: {e}")))?;
                let img = if img.width() > 2400 || img.height() > 2400 { img.thumbnail(2400, 2400) } else { img };
                let mut out = std::io::Cursor::new(Vec::new());
                img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| ApiError::new(500, e.to_string()))?;
                Ok(("image/png".into(), out.into_inner()))
            }
            "text" => {
                use std::io::Read;
                let mut buf = Vec::new();
                std::fs::File::open(&path).and_then(|f| f.take(256 * 1024).read_to_end(&mut buf)).map_err(|_| ApiError::new(404, "File not reachable"))?;
                Ok(("text/plain; charset=utf-8".into(), String::from_utf8_lossy(&buf).into_owned().into_bytes()))
            }
            _ => {
                let ct = match ext.as_str() {
                    "pdf" => "application/pdf",
                    "jpg" | "jpeg" | "jfif" => "image/jpeg",
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "bmp" => "image/bmp",
                    "webp" => "image/webp",
                    "txt" | "log" | "csv" => "text/plain; charset=utf-8",
                    _ => "application/octet-stream",
                };
                let bytes = std::fs::read(&path).map_err(|_| ApiError::new(404, "File not reachable"))?;
                Ok((ct.into(), bytes))
            }
        }
    }

    pub fn serve_asset(name: &str) -> Option<(&'static str, &'static [u8])> {
        match name {
            "cat.gif" => Some(("image/gif", include_bytes!("../../assets/Loading_Cat.gif"))),
            "logo.png" => Some(("image/png", include_bytes!("../../assets/TracePoint_Logo_Transparent.png"))),
            "mark.png" => Some(("image/png", include_bytes!("../../assets/mark512.png"))),
            _ => None,
        }
    }

    /// The cleanup report's sheets, from the files this person can see.
    fn cleanup_rows(&self, e: &Engine) -> Vec<(&'static str, &'static str, Rows)> {
        use crate::export::CleanupRow;
        let idx = &e.idx;
        let row = |fi: u32, what: String, better: Option<u32>, why: String| {
            let f = &idx.files[fi as usize];
            CleanupRow {
                file: f.name.clone(),
                path: idx.full_path(fi),
                what,
                better: better.map(|b| format!("{} — {}", idx.files[b as usize].name, idx.relative_folder(idx.files[b as usize].dir))).unwrap_or_default(),
                better_path: better.map(|b| idx.full_path(b)).unwrap_or_default(),
                why,
            }
        };
        let (mut sup, mut stale, mut copies, mut stranded, mut scans) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut ids: Vec<&u32> = e.links.files.keys().collect();
        ids.sort();
        for &fi in ids {
            let l = &e.links.files[&fi];
            let f = &idx.files[fi as usize];
            if f.flags & crate::link::F_PRIVATE != 0 {
                continue;
            }
            if let Some(n) = l.newer {
                let r = row(fi, "Superseded revision".into(), Some(n), l.newer_why.clone().unwrap_or_default());
                if l.stale_copy {
                    stale.push(row(fi, "Old revision saved more recently".into(), Some(n), l.newer_why.clone().unwrap_or_default()));
                }
                sup.push(r);
            }
            if let Some(h) = l.home {
                copies.push(row(fi, format!("Copy ({} copies in all)", l.copies + 1), Some(h), "Same file; the best-kept copy is shown".into()));
            }
            for &ei in &l.stranded_for {
                let eq = &idx.equipment[ei as usize];
                let why = l.content_equip.iter().find(|x| x.0 == ei).map(|x| x.1.clone()).unwrap_or_else(|| "Its number is in the file name".into());
                stranded.push(CleanupRow { better: format!("{} {} — {}", eq.number, eq.description, eq.folder_path.clone().unwrap_or_default()), better_path: eq.folder_path.clone().unwrap_or_default(), ..row(fi, format!("About {} but not filed with it", eq.number), None, why) });
            }
            if crate::crawl::classify_filename(&f.name) == "MACHINE_GENERATED" && !l.content_equip.is_empty() {
                let eq = &idx.equipment[l.content_equip[0].0 as usize];
                scans.push(row(fi, format!("Scan identified as {}", eq.number), None, l.content_equip[0].1.clone()));
            }
        }
        vec![
            ("Superseded", "Older revisions — a newer one exists (by the revision stated in the documents first, then dates).", Rows(sup)),
            ("Stale copies", "Old revisions saved more recently than the newest one — the copies people keep using by mistake.", Rows(stale)),
            ("Stranded", "Documents about a piece of equipment that aren't filed in its folder (projects, scans, department folders).", Rows(stranded)),
            ("Identified scans", "Scanner-named files tied to equipment by their contents.", Rows(scans)),
            ("Duplicates", "Extra copies of the same file.", Rows(copies)),
        ]
    }

    pub fn about(&self) -> Value {
        let t = self.team.read().unwrap().clone();
        json!({
            "version": VERSION,
            "me": self.me.account,
            "local_data": self.paths.local.display().to_string(),
            "temp": self.paths.temp.display().to_string(),
            "team": t,
            "default_team": crate::team::DEFAULT_TEAM,
            "groups": *self.groups.read().unwrap(),
            "protected_roots": self.guard.protected_roots(),
            "writable": self.guard.writable_dirs(),
            "index": self.index_state.read().unwrap().clone(),
            "policy_key": "HKLM\\SOFTWARE\\Policies\\TracePoint",
            "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
            "exe_sha256": std::env::current_exe().ok().and_then(|p| std::fs::read(p).ok()).map(|b| sha2_hex(&b)),
            "machine": self.platform.machine(),
        })
    }
}
