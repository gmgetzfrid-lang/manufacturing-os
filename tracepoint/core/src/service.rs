//! The TracePoint service: every command the interface can call, with all
//! permission checks done here (the interface is never trusted).
//!
//! Platform-neutral. The Windows app plugs in a `Platform` that opens files,
//! shows dialogs and pushes events; the dev server plugs in a stub.

use crate::ai::{self, AiChoice, Provider};
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
}

#[derive(Clone, Debug, Default, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct LocalConfig {
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

pub struct Service {
    pub platform: Box<dyn Platform>,
    pub guard: Guard,
    pub paths: Paths,
    pub embedded_index: Option<&'static [u8]>,
    engine: RwLock<Option<Arc<Engine>>>,
    index_state: RwLock<IndexState>,
    users: Mutex<UserStore>,
    profiles_path: PathBuf,
    session: Mutex<Option<Session>>,
    config: RwLock<LocalConfig>,
    chat_cancel: AtomicBool,
    /// The database file the engine was loaded from (rescans start from it).
    active_db: RwLock<Option<PathBuf>>,
    scan: Mutex<ScanState>,
    scan_cancel: Arc<AtomicBool>,
    content: Mutex<ContentState>,
    content_cancel: Arc<AtomicBool>,
    airead: Mutex<AiReadState>,
    airead_cancel: Arc<AtomicBool>,
    /// pdfium.dll (unpacked from the exe by the app) or libpdfium.so (dev).
    pdfium_lib: RwLock<Option<PathBuf>>,
}

/// Progress of the approved AI reading of pages free OCR couldn't read.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct AiReadState {
    pub running: bool,
    pub approved: usize,
    pub done: usize,
    pub empty: usize,
    pub failed: usize,
    pub spent_usd: f64,
    pub model: Option<String>,
    pub current: Option<String>,
    pub started: Option<String>,
    pub finished: Option<String>,
    pub stopped_reason: Option<String>,
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
    pub staged_for_ai: usize,
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
impl From<ai::AiError> for ApiError {
    fn from(e: ai::AiError) -> Self {
        ApiError::new(e.status.unwrap_or(502), e.message)
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

impl Service {
    pub fn new(platform: Box<dyn Platform>, local: PathBuf, embedded_index: Option<&'static [u8]>) -> Result<Arc<Service>, String> {
        let guard = Guard::new(platform.drive_resolver());
        let temp = std::env::temp_dir().join("TracePoint");
        std::fs::create_dir_all(&local).map_err(|e| format!("Cannot create {}: {e}", local.display()))?;
        guard.allow(&local).map_err(|e| e.to_string())?;
        guard.allow(&temp).map_err(|e| e.to_string())?;
        let config: LocalConfig = std::fs::read(local.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // Profiles live in the team folder when one is set and reachable.
        let mut profiles_path = local.join("profiles.db");
        if let Some(t) = &config.team_folder {
            let tp = PathBuf::from(t);
            if tp.is_dir() && guard.allow(&tp).is_ok() {
                profiles_path = tp.join("TracePoint_Profiles.db");
            }
        }
        let users = UserStore::open(&profiles_path).map_err(|e| e.0)?;
        Ok(Arc::new(Service {
            platform,
            guard,
            paths: Paths { local, temp },
            embedded_index,
            engine: RwLock::new(None),
            index_state: RwLock::new(IndexState { ready: false, message: "Starting…".into(), source: String::new(), source_kind: String::new(), error: None }),
            users: Mutex::new(users),
            profiles_path,
            session: Mutex::new(None),
            config: RwLock::new(config),
            chat_cancel: AtomicBool::new(false),
            active_db: RwLock::new(None),
            scan: Mutex::new(ScanState::default()),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            content: Mutex::new(ContentState::default()),
            content_cancel: Arc::new(AtomicBool::new(false)),
            pdfium_lib: RwLock::new(None),
            airead: Mutex::new(AiReadState::default()),
            airead_cancel: Arc::new(AtomicBool::new(false)),
        }))
    }

    fn set_index_msg(&self, m: &str) {
        self.index_state.write().unwrap().message = m.to_string();
        self.platform.emit("index", json!({"message": m}));
    }

    /// Find the best available index and load it. Runs on a background thread.
    pub fn load_index(self: &Arc<Self>) {
        let t0 = std::time::Instant::now();
        let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(t) = &self.config.read().unwrap().team_folder {
            candidates.push((PathBuf::from(t).join("index").join("thor_knowledge.db"), "team"));
        }
        candidates.push((self.paths.local.join("index").join("thor_knowledge.db"), "local"));
        let mut chosen: Option<(PathBuf, String)> = None;
        for (p, kind) in candidates {
            if p.is_file() {
                if kind == "team" {
                    // Copy the published index locally when it is newer, then load the copy.
                    let local_copy = self.paths.local.join("index").join("team_copy.db");
                    let newer = match (std::fs::metadata(&p), std::fs::metadata(&local_copy)) {
                        (Ok(a), Ok(b)) => a.modified().ok() > b.modified().ok() || a.len() != b.len(),
                        (Ok(_), Err(_)) => true,
                        _ => false,
                    };
                    if newer {
                        self.set_index_msg("Copying the team index from the shared folder…");
                        if self.guard.copy_into(&p, &local_copy).is_err() {
                            continue;
                        }
                    }
                    chosen = Some((local_copy, format!("Team index ({})", p.display())));
                } else {
                    chosen = Some((p.clone(), format!("Local index ({})", p.display())));
                }
                break;
            }
        }
        if chosen.is_none() {
            if let Some(bytes) = self.embedded_index {
                let h = {
                    let mut x: u64 = 1469598103934665603;
                    for b in bytes.iter().step_by(4096) {
                        x = (x ^ *b as u64).wrapping_mul(1099511628211);
                    }
                    x ^ bytes.len() as u64
                };
                let path = self.paths.local.join("index").join(format!("built-in-{h:016x}.db"));
                if !path.is_file() {
                    self.set_index_msg("Unpacking the built-in THOR index (first start only)…");
                    match crate::snapshot::decompress(bytes) {
                        Ok(raw) => {
                            if let Err(e) = self.guard.write(&path, &raw) {
                                self.fail_index(&format!("Could not unpack the built-in index: {e}"));
                                return;
                            }
                        }
                        Err(e) => {
                            self.fail_index(&format!("Built-in index is damaged: {e}"));
                            return;
                        }
                    }
                }
                chosen = Some((path, "Built-in index (shipped inside TracePoint.exe)".into()));
            }
        }
        let Some((path, source)) = chosen else {
            self.fail_index("No THOR index is available yet. An administrator can import one under Sources.");
            return;
        };
        self.set_index_msg("Reading 200,000+ THOR file records…");
        *self.active_db.write().unwrap() = Some(path.clone());
        match Index::load(&path) {
            Ok(idx) => {
                for r in &idx.roots {
                    self.guard.protect(&r.path);
                }
                self.set_index_msg("Building the search engine…");
                let engine = Engine::new(idx);
                self.attach_content(&engine);
                let files = engine.idx.files.len();
                *self.engine.write().unwrap() = Some(Arc::new(engine));
                let kind = if source.starts_with("Team") { "team" } else if source.starts_with("Local") { "local" } else { "builtin" };
                *self.index_state.write().unwrap() = IndexState {
                    ready: true,
                    message: format!("{files} files ready in {:.1} s", t0.elapsed().as_secs_f64()),
                    source,
                    source_kind: kind.into(),
                    error: None,
                };
                self.platform.emit("index", json!({"ready": true}));
            }
            Err(e) => self.fail_index(&e),
        }
    }

    /// Where this PC reads document text from: the team copy when newer,
    /// else the local one.
    fn content_db(&self) -> PathBuf {
        let dir = self.paths.local.join("index");
        if let Some(t) = &self.config.read().unwrap().team_folder {
            let team = PathBuf::from(t).join("index").join("thor_content.db");
            let local = dir.join("thor_content.db");
            let newer = match (std::fs::metadata(&team), std::fs::metadata(&local)) {
                (Ok(a), Ok(b)) => a.modified().ok() > b.modified().ok(),
                (Ok(_), Err(_)) => true,
                _ => false,
            };
            if newer {
                let _ = self.guard.copy_into(&team, &local);
            }
        }
        dir.join("thor_content.db")
    }

    fn attach_content(&self, engine: &Engine) {
        let p = self.content_db();
        *engine.content.write().unwrap() = if p.is_file() { crate::engine::ContentIndex::open(&p, &engine.idx) } else { None };
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
        let dir = self.paths.local.join("index");
        let active = self.content_db();
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
        let mut todo: Vec<(u32, f32)> = e
            .idx
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.flags & crate::index::F_GONE == 0 && content::readable_ext(&f.ext) && f.size > 0 && (f.size as u64) <= content::MAX_FILE_BYTES)
            .filter(|(_, f)| known.get(&f.file_id).map(|k| *k != (f.size, f.mtime)).unwrap_or(true))
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
        self.audit("content_started", &format!("{} documents to read", todo.len()));

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
                    let got: Vec<_> = chunk.par_iter().map(|(fi, v, p)| (*fi, *v, std::fs::read(crate::crawl::os_path(p)).map_err(|x| x.to_string()))).collect();
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
            let x = match bytes {
                Ok(b) => ex.extract(b, &f.ext, if value >= 0.3 { 30 } else { 0 }),
                Err(err) => content::Extracted { error: Some(format!("Could not read: {err}")), ..Default::default() },
            };
            let _ = content::save(&c, &f.file_id, &e.idx.full_path(fi), f.size, f.mtime, value, &x, &now);
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
                    st.staged_for_ai += x.unreadable.len().min(20);
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
        let local = dir.join("thor_content.db");
        let res = self.guard.publish(&work, &local);
        let _ = self.guard.remove_own_file(&work);
        if let Err(x) = res {
            self.attach_content(&e);
            return fail(&self, format!("Could not save the content database: {x}"));
        }
        if let Some(t) = self.config.read().unwrap().team_folder.clone() {
            let _ = self.guard.publish(&local, &PathBuf::from(t).join("index").join("thor_content.db"));
        }
        self.attach_content(&e);
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
        self.audit("content_finished", &format!("{} of {} documents read · {} pages · {} OCR pages · {} pages staged for AI{}", st.done, st.total, st.pages, st.ocr_pages, st.staged_for_ai, if stopped { " (stopped)" } else { "" }));
    }

    /// Staged pages, most valuable first: (file index, file_id, page, value).
    fn staged_pages(&self, e: &Engine, limit: usize) -> Vec<(u32, String, u32, f64)> {
        let path = self.content_db();
        let Ok(c) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
        let by_id: std::collections::HashMap<&str, u32> = e.idx.files.iter().enumerate().map(|(i, f)| (f.file_id.as_str(), i as u32)).collect();
        let Ok(mut st) = c.prepare("select file_id, page, value from ai_stage where status='staged' order by value desc, file_id, page") else { return vec![] };
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, f64>(2)?)));
        let mut out = Vec::new();
        if let Ok(rows) = rows {
            for (fid, page, v) in rows.flatten() {
                if let Some(&fi) = by_id.get(fid.as_str()) {
                    out.push((fi, fid, page as u32, v));
                    if out.len() >= limit {
                        break;
                    }
                }
            }
        }
        out
    }

    fn airead_emit(&self) {
        let v = serde_json::to_value(&*self.airead.lock().unwrap()).unwrap();
        self.platform.emit("airead", v);
    }

    /// Read the `count` most valuable staged pages with the admin's cheapest
    /// vision model, each call within the indexing budget.
    fn run_airead(self: Arc<Self>, count: usize, choice: AiChoice, key: zeroize::Zeroizing<String>) {
        use base64::Engine as _;
        let Ok(e) = self.engine() else { return };
        let pages = self.staged_pages(&e, count);
        {
            let mut st = self.airead.lock().unwrap();
            *st = AiReadState { running: true, approved: pages.len(), model: Some(choice.model.clone()), started: Some(auth::now()), ..Default::default() };
        }
        self.airead_cancel.store(false, Ordering::SeqCst);
        self.airead_emit();
        self.audit("ai_read_started", &format!("{} pages with {}", pages.len(), choice.model));
        let stop = |me: &Self, reason: Option<String>| {
            let mut st = me.airead.lock().unwrap();
            st.running = false;
            st.finished = Some(auth::now());
            st.current = None;
            st.stopped_reason = reason;
            drop(st);
            me.airead_emit();
        };
        let dir = self.paths.local.join("index");
        let active = self.content_db();
        let work = dir.join("airead_work.db");
        let _ = self.guard.remove_own_file(&work);
        if self.guard.copy_into(&active, &work).is_err() {
            return stop(&self, Some("Could not copy the content database.".into()));
        }
        let Ok(c) = rusqlite::Connection::open(&work) else { return stop(&self, Some("Could not open the content database.".into())) };
        let _ = c.pragma_update(None, "journal_mode", "MEMORY");
        let ex = crate::content::Extractor::new(self.pdfium_lib.read().unwrap().as_deref(), false);
        let mut reason: Option<String> = None;
        for (fi, fid, page, _v) in pages {
            if self.airead_cancel.load(Ordering::Relaxed) {
                reason = Some("Stopped by you".into());
                break;
            }
            let f = &e.idx.files[fi as usize];
            self.airead.lock().unwrap().current = Some(format!("{} · page {page}", f.name));
            self.airead_emit();
            let png = std::fs::read(crate::crawl::os_path(&e.idx.full_path(fi))).map_err(|x| x.to_string()).and_then(|b| ex.page_png(b, &f.ext, page, 1568));
            let png = match png {
                Ok(p) => p,
                Err(_) => {
                    let _ = c.execute("update ai_stage set status='failed' where file_id=?1 and page=?2", rusqlite::params![fid, page]);
                    self.airead.lock().unwrap().failed += 1;
                    continue;
                }
            };
            let msg = ai::Msg { role: "user".into(), content: format!("Page {page} of \"{}\" (folder: {}).", f.name, e.idx.relative_folder(f.dir)), images: vec![base64::engine::general_purpose::STANDARD.encode(&png)] };
            match self.ai_call("index", &choice, &key, crate::content::AI_READ_PROMPT, &[msg], crate::content::AI_PAGE_MAX_OUTPUT, &|| false, &mut |_| {}) {
                Ok((r, cost)) => {
                    let _ = crate::content::save_ai_page(&c, &fid, page, &r.text, cost, &auth::now());
                    let mut st = self.airead.lock().unwrap();
                    st.spent_usd += cost;
                    if r.text.trim() == "EMPTY" {
                        st.empty += 1;
                    } else {
                        st.done += 1;
                    }
                }
                Err(err) if err.status == Some(402) || err.status == Some(401) || err.status == Some(403) => {
                    reason = Some(err.message);
                    break;
                }
                Err(_) => {
                    let _ = c.execute("update ai_stage set status='failed' where file_id=?1 and page=?2", rusqlite::params![fid, page]);
                    self.airead.lock().unwrap().failed += 1;
                }
            }
        }
        drop(c);
        // Swap in the content database with the new text and publish it.
        *e.content.write().unwrap() = None;
        let local = dir.join("thor_content.db");
        let ok = self.guard.publish(&work, &local).is_ok();
        let _ = self.guard.remove_own_file(&work);
        if ok {
            if let Some(t) = self.config.read().unwrap().team_folder.clone() {
                let _ = self.guard.publish(&local, &PathBuf::from(t).join("index").join("thor_content.db"));
            }
        }
        self.attach_content(&e);
        let st = self.airead.lock().unwrap().clone();
        self.audit("ai_read_finished", &format!("{} pages read, {} empty, {} failed, ${:.4}{}", st.done, st.empty, st.failed, st.spent_usd, reason.as_deref().map(|r| format!(" — {r}")).unwrap_or_default()));
        stop(&self, reason.or(if ok { None } else { Some("Could not save the results.".into()) }));
    }

    fn fail_index(&self, e: &str) {
        let mut st = self.index_state.write().unwrap();
        st.ready = false;
        st.error = Some(e.to_string());
        st.message = e.to_string();
        drop(st);
        self.platform.emit("index", json!({"error": e}));
    }

    fn engine(&self) -> Result<Arc<Engine>, ApiError> {
        self.engine.read().unwrap().clone().ok_or_else(|| ApiError::new(503, "The THOR index is still loading."))
    }

    fn with_session<T>(&self, f: impl FnOnce(&Session) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let g = self.session.lock().unwrap();
        match g.as_ref() {
            Some(s) if !s.user.must_change => f(s),
            Some(_) => Err(ApiError::new(403, "Change your temporary password first.")),
            None => Err(ApiError::new(401, "Please sign in.")),
        }
    }

    fn require(&self, pred: impl FnOnce(&Session) -> bool, msg: &str) -> Result<(), ApiError> {
        self.with_session(|s| if pred(s) { Ok(()) } else { Err(ApiError::new(403, msg)) })
    }

    fn state(&self) -> Value {
        let sess = self.session.lock().unwrap();
        let stage = match sess.as_ref() {
            None => "login",
            Some(s) if s.user.must_change => "change_password",
            Some(_) => "ready",
        };
        let users = self.users.lock().unwrap();
        let ai_enabled = users.policy("ai_enabled").ok().flatten().map(|v| v == "true").unwrap_or(true);
        let allowed = users.policy("ai_providers").ok().flatten().unwrap_or_else(|| "anthropic,openai,gemini".into());
        let prefs: Vec<(String, String)> = sess.as_ref().and_then(|s| users.prefs(s).ok()).unwrap_or_default();
        let idx = self.index_state.read().unwrap().clone();
        json!({
            "stage": stage,
            "version": VERSION,
            "user": sess.as_ref().map(|s| &s.user),
            "keys_unlocked": sess.as_ref().map(|s| s.unlocked()).unwrap_or(false),
            "index": idx,
            "policy": {"ai_enabled": ai_enabled, "ai_providers": allowed.split(',').collect::<Vec<_>>()},
            "prefs": prefs.into_iter().collect::<std::collections::HashMap<_, _>>(),
            "profiles_location": self.profiles_path.display().to_string(),
        })
    }

    fn file_path(&self, id: u32) -> Result<PathBuf, ApiError> {
        let e = self.engine()?;
        if id as usize >= e.idx.files.len() {
            return Err(ApiError::new(404, "No such file."));
        }
        Ok(crate::crawl::os_path(&e.idx.full_path(id)))
    }

    /// Handle one command. `cmd` is a dotted name, `a` its JSON arguments.
    pub fn handle(self: &Arc<Self>, cmd: &str, a: &Value) -> R {
        match cmd {
            // ── Session ──────────────────────────────────────────────
            "state" => Ok(self.state()),
            "auth.login" => {
                let sess = self.users.lock().unwrap().login(&s(a, "email"), &s(a, "password"))?;
                *self.session.lock().unwrap() = Some(sess);
                Ok(self.state())
            }
            "auth.change_password" => {
                let mut g = self.session.lock().unwrap();
                let sess = g.as_mut().ok_or_else(|| ApiError::new(401, "Please sign in."))?;
                self.users.lock().unwrap().change_password(sess, &s(a, "current"), &s(a, "new"))?;
                drop(g);
                Ok(self.state())
            }
            "auth.check_password" => {
                let email = self.session.lock().unwrap().as_ref().map(|s| s.user.email.clone()).unwrap_or_default();
                Ok(json!({"problem": auth::password_problem(&email, &s(a, "password"))}))
            }
            "auth.logout" => {
                if let Some(sess) = self.session.lock().unwrap().take() {
                    let _ = self.users.lock().unwrap().audit(Some(&sess.user.email), "logout", "Signed out");
                }
                Ok(self.state())
            }
            "auth.set_pref" => self.with_session(|sess| {
                let k = s(a, "key");
                if !["open_mode", "density", "results_view", "home_hint"].contains(&k.as_str()) {
                    return Err(ApiError::new(400, "Unknown preference."));
                }
                self.users.lock().unwrap().set_pref(sess, &k, &s(a, "value"))?;
                Ok(json!({"ok": true}))
            }),

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
                self.with_session(|_| Ok(()))?;
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
                          "writable": self.guard.writable_dirs(), "team_folder": self.config.read().unwrap().team_folder}))
            }
            "index.reload" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can reload the index.")?;
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"started": true}))
            }
            "index.import" => {
                self.require(|s| s.user.role.can_rescan(), "Only administrators and indexers can import an index.")?;
                let Some(src) = self.platform.open_dialog("Choose a THOR knowledge database (thor_knowledge.db)", "db") else {
                    return Ok(json!({"cancelled": true}));
                };
                // Validate before copying.
                Index::load(&src).map_err(|e| ApiError::new(400, format!("That file can't be used: {e}")))?;
                let dest = self.paths.local.join("index").join("thor_knowledge.db");
                self.guard.copy_into(&src, &dest)?;
                self.audit("index_imported", &src.display().to_string());
                let me = self.clone();
                std::thread::spawn(move || me.load_index());
                Ok(json!({"imported": dest.display().to_string()}))
            }

            // ── Administration ───────────────────────────────────────
            "admin.users" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                Ok(serde_json::to_value(self.users.lock().unwrap().list()?).unwrap())
            }),
            "admin.user.create" => self.with_session(|sess| {
                let role = Role::parse(&s(a, "role")).ok_or_else(|| ApiError::new(400, "Choose a role."))?;
                let u = self.users.lock().unwrap().create_user(sess, &s(a, "email"), &s(a, "name"), role, &s(a, "temp_password"))?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.update" => self.with_session(|sess| {
                let id = a["id"].as_i64().unwrap_or(0);
                let role = a.get("role").and_then(|r| r.as_str()).and_then(Role::parse);
                let u = self.users.lock().unwrap().update_user(
                    sess,
                    id,
                    a.get("name").and_then(|x| x.as_str()),
                    role,
                    a.get("disabled").and_then(|x| x.as_bool()),
                    a.get("can_ai").and_then(|x| x.as_bool()),
                )?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.reset" => self.with_session(|sess| {
                let u = self.users.lock().unwrap().reset_password(sess, a["id"].as_i64().unwrap_or(0), &s(a, "temp_password"))?;
                Ok(serde_json::to_value(u).unwrap())
            }),
            "admin.user.delete" => self.with_session(|sess| {
                self.users.lock().unwrap().delete_user(sess, a["id"].as_i64().unwrap_or(0))?;
                Ok(json!({"ok": true}))
            }),
            "admin.policy.set" => self.with_session(|sess| {
                let k = s(a, "key");
                if !["ai_enabled", "ai_providers", "ai_send_documents"].contains(&k.as_str()) {
                    return Err(ApiError::new(400, "Unknown policy."));
                }
                self.users.lock().unwrap().set_policy(sess, &k, &s(a, "value"))?;
                Ok(self.state())
            }),
            "admin.audit" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                let rows = self.users.lock().unwrap().audit_log(500)?;
                Ok(Value::Array(rows.into_iter().map(|r| json!({"at": r.0, "actor": r.1, "action": r.2, "detail": r.3, "machine": r.4})).collect()))
            }),
            "admin.team_folder" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "Administrators only."));
                }
                let folder = if a.get("pick").and_then(|x| x.as_bool()).unwrap_or(false) {
                    match self.platform.pick_folder("Choose the shared TracePoint team folder") {
                        Some(p) => Some(p.display().to_string()),
                        None => return Ok(json!({"cancelled": true})),
                    }
                } else {
                    a.get("path").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string())
                };
                if let Some(f) = &folder {
                    self.guard.allow(Path::new(f))?;
                }
                let mut cfg = self.config.write().unwrap();
                cfg.team_folder = folder.clone();
                self.guard.write(&self.paths.local.join("config.json"), serde_json::to_string_pretty(&*cfg).unwrap().as_bytes())?;
                drop(cfg);
                self.audit("team_folder_set", folder.as_deref().unwrap_or("(none)"));
                Ok(json!({"team_folder": folder, "restart_required": true}))
            }),

            // ── AI ───────────────────────────────────────────────────
            "ai.providers" => {
                self.require(|s| s.is_admin(), "AI features are available to administrator profiles only.")?;
                Ok(serde_json::to_value(ai::providers()).unwrap())
            }
            "ai.get" => self.with_session(|sess| {
                let users = self.users.lock().unwrap();
                let prefs: std::collections::HashMap<String, String> = users.prefs(sess)?.into_iter().collect();
                let key = users.get_secret(sess, "ai_key")?;
                Ok(json!({
                    "provider": prefs.get("ai_provider"), "model": prefs.get("ai_model"), "reasoning": prefs.get("ai_reasoning"),
                    "key_mask": key.as_ref().map(|k| ai::mask_key(k)), "has_key": key.is_some(), "can_ai": sess.is_admin() && sess.user.can_ai,
                }))
            }),
            "ai.models" => {
                let (provider, key) = self.ai_key_for(a)?;
                let models = ai::list_models(provider, &key)?;
                // Each model with its published price and what a typical question costs.
                let out: Vec<Value> = models
                    .into_iter()
                    .map(|m| {
                        let q = self.price_for(provider, &m.id, 6000);
                        let mut v = serde_json::to_value(&m).unwrap();
                        v["price"] = json!({"input": q.price.input, "output": q.price.output, "basis": q.basis, "note": q.note, "per_question": crate::pricing::cost(&q.price, 6000, 1000, 0, 0)});
                        v
                    })
                    .collect();
                Ok(Value::Array(out))
            }
            "ai.test" => {
                let (provider, key) = self.ai_key_for(a)?;
                let choice = AiChoice { provider, model: s(a, "model"), reasoning: a.get("reasoning").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()) };
                let t0 = std::time::Instant::now();
                let msgs = vec![ai::Msg { role: "user".into(), content: "Reply with exactly: TracePoint connected".into(), images: vec![] }];
                let (r, cost) = self.ai_call("test", &choice, &key, "You are a connection test. Reply with the exact words requested.", &msgs, 2000, &|| false, &mut |_| {})?;
                Ok(json!({"ok": true, "reply": r.text, "model": r.model, "reasoning_used": r.reasoning_used, "ms": t0.elapsed().as_millis(), "cost_usd": cost}))
            }
            "ai.save" => {
                // ai_key_for enforces: administrators only, AI allowed, provider allowed.
                let (provider, key) = self.ai_key_for(a)?;
                self.with_session(|sess| {
                    let users = self.users.lock().unwrap();
                    if a.get("key").and_then(|k| k.as_str()).map(|k| !k.trim().is_empty()).unwrap_or(false) {
                        users.put_secret(sess, "ai_key", key.trim())?;
                    }
                    users.set_pref(sess, "ai_provider", provider.as_str())?;
                    users.set_pref(sess, "ai_model", &s(a, "model"))?;
                    users.set_pref(sess, "ai_reasoning", &s(a, "reasoning"))?;
                    users.audit(Some(&sess.user.email), "ai_configured", &format!("{} / {} / {}", provider.as_str(), s(a, "model"), s(a, "reasoning")))?;
                    Ok(json!({"ok": true}))
                })
            }
            "ai.delete" => self.with_session(|sess| {
                let users = self.users.lock().unwrap();
                users.delete_secret(sess, "ai_key")?;
                Ok(json!({"ok": true}))
            }),
            "ai.budget" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "AI features are available to administrator profiles only."));
                }
                let (budget, share, max_request) = self.ai_limits(sess);
                let month = auth::now()[..7].to_string();
                let users = self.users.lock().unwrap();
                let (q, i, held, calls) = users.ai_month(sess.user.id, &month)?;
                let rows = users.ai_usage_rows(sess.user.id, 300)?;
                let prefs: std::collections::HashMap<String, String> = users.prefs(sess)?.into_iter().collect();
                drop(users);
                let day = auth::now()[..10].to_string();
                let current = prefs.get("ai_provider").and_then(|p| Provider::parse(p)).map(|p| {
                    let m = prefs.get("ai_model").cloned().unwrap_or_default();
                    let qt = self.price_for(p, &m, 6000);
                    json!({"provider": p.as_str(), "model": m, "price": qt.price, "basis": qt.basis, "note": qt.note, "per_question": crate::pricing::cost(&qt.price, 6000, 1000, 0, 0)})
                });
                Ok(json!({
                    "budget_usd": budget, "index_share_pct": share * 100.0, "max_request_usd": max_request, "month": month,
                    "spent_questions_usd": q, "spent_index_usd": i, "held_usd": held, "calls": calls,
                    "cap_questions_usd": budget * (1.0 - share), "cap_index_usd": budget * share,
                    "current": current, "prices": crate::pricing::table(&day), "upcoming": crate::pricing::upcoming(&day),
                    "prices_checked": crate::pricing::PRICES_CHECKED, "sources": crate::pricing::SOURCES, "rows": rows,
                }))
            }),
            "ai.budget.set" => self.with_session(|sess| {
                if !sess.is_admin() {
                    return Err(ApiError::new(403, "AI features are available to administrator profiles only."));
                }
                let users = self.users.lock().unwrap();
                for (k, lo, hi) in [("ai_budget_usd", 0.0, 10_000.0), ("ai_index_share_pct", 0.0, 100.0), ("ai_max_request_usd", 0.01, 100.0)] {
                    if let Some(v) = a.get(k).and_then(|x| x.as_f64()) {
                        if !(lo..=hi).contains(&v) {
                            return Err(ApiError::new(400, format!("{k} must be between {lo} and {hi}.")));
                        }
                        users.set_pref(sess, k, &v.to_string())?;
                    }
                }
                users.audit(Some(&sess.user.email), "ai_budget_set", &a.to_string())?;
                Ok(json!({"ok": true}))
            }),
            "search.ai" => {
                let (choice, key) = self.current_ai()?;
                let e = self.engine()?;
                let history: Vec<ai::Msg> = a.get("history").and_then(|h| serde_json::from_value(h.clone()).ok()).unwrap_or_default();
                let q = s(a, "query");
                if q.trim().is_empty() {
                    return Err(ApiError::new(400, "Describe what you're looking for."));
                }
                let plat = &self.platform;
                let spent = std::cell::Cell::new(0.0f64);
                let call = |c: &AiChoice, sys: &str, msgs: &[ai::Msg], max: u32| {
                    let (r, cost) = self.ai_call("find", c, &key, sys, msgs, max, &|| false, &mut |_| {})?;
                    spent.set(spent.get() + cost);
                    Ok(r)
                };
                let mut r = crate::aifind::find(&e, &choice, &call, &q, &history, &|m| plat.emit("aifind", json!({"status": m})))?;
                r.value["cost_usd"] = json!(spent.get());
                self.audit("ai_find", &format!("{} / {} · ${:.4}", choice.provider.as_str(), choice.model, spent.get()));
                Ok(r.value)
            }
            "ai.cancel" => {
                self.chat_cancel.store(true, Ordering::SeqCst);
                Ok(json!({"ok": true}))
            }

            // ── About / for IT ───────────────────────────────────────
            "about" => Ok(self.about()),
            "chat.threads" | "library.list" => {
                self.require(|s| s.is_admin(), "AI features are available to administrator profiles only.")?;
                Ok(json!([]))
            }
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
            "airead.summary" => {
                self.require(|s| s.is_admin(), "AI features are available to administrator profiles only.")?;
                let e = self.engine()?;
                let pages = self.staged_pages(&e, 100_000);
                let (provider, budget) = self.with_session(|sess| {
                    let prefs: std::collections::HashMap<String, String> = self.users.lock().unwrap().prefs(sess)?.into_iter().collect();
                    Ok((prefs.get("ai_provider").and_then(|p| Provider::parse(p)), self.ai_limits(sess)))
                })?;
                let mut by_cat: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
                for (fi, ..) in &pages {
                    *by_cat.entry(e.idx.files[*fi as usize].cat.label()).or_default() += 1;
                }
                let top: Vec<Value> = pages.iter().take(300).map(|(fi, _, page, v)| {
                    let f = &e.idx.files[*fi as usize];
                    json!({"id": fi, "name": f.name, "page": page, "value": v, "doctype": f.doctype, "year": f.year, "folder": e.idx.relative_folder(f.dir)})
                }).collect();
                let model = provider.map(crate::content::vision_model);
                let (per_page, per_page_worst, basis) = match (provider, model) {
                    (Some(p), Some(m)) => {
                        let q = self.price_for(p, m, crate::content::AI_PAGE_TOKENS.0);
                        (crate::pricing::cost(&q.price, crate::content::AI_PAGE_TOKENS.0, crate::content::AI_PAGE_TOKENS.1, 0, 0), crate::pricing::worst_case(&q.price, crate::content::AI_PAGE_TOKENS.0, crate::content::AI_PAGE_MAX_OUTPUT as u64), q.basis)
                    }
                    _ => (0.0, 0.0, "none"),
                };
                let month = auth::now()[..7].to_string();
                let uid = self.with_session(|s| Ok(s.user.id))?;
                let (_, spent_i, held, _) = self.users.lock().unwrap().ai_month(uid, &month)?;
                let cap_index = budget.0 * budget.1;
                Ok(json!({
                    "staged": pages.len(), "by_category": by_cat, "top": top, "provider": provider.map(|p| p.as_str()), "model": model,
                    "per_page": per_page, "per_page_worst": per_page_worst, "price_basis": basis,
                    "cap_index_usd": cap_index, "left_index_usd": (cap_index - spent_i - held).max(0.0),
                    "running": self.airead.lock().unwrap().clone(),
                }))
            }
            "airead.start" => {
                self.require(|s| s.is_admin(), "AI features are available to administrator profiles only.")?;
                if self.airead.lock().unwrap().running || self.content.lock().unwrap().running {
                    return Err(ApiError::new(409, "Document reading is already running."));
                }
                let count = a.get("count").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                if count == 0 {
                    return Err(ApiError::new(400, "Choose how many pages to read."));
                }
                let (cur, key) = self.current_ai()?;
                let choice = AiChoice { provider: cur.provider, model: crate::content::vision_model(cur.provider).to_string(), reasoning: None };
                let me = self.clone();
                std::thread::spawn(move || me.run_airead(count, choice, key));
                Ok(json!({"started": true}))
            }
            "airead.status" => {
                self.with_session(|_| Ok(()))?;
                Ok(serde_json::to_value(&*self.airead.lock().unwrap()).unwrap())
            }
            "airead.stop" => {
                self.require(|s| s.is_admin(), "AI features are available to administrator profiles only.")?;
                self.airead_cancel.store(true, Ordering::SeqCst);
                Ok(json!({"stopping": true}))
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

    // ── AI spending caps ───────────────────────────────────────────────

    /// The signed-in admin's limits: monthly budget, share for indexing,
    /// most one request may cost. Defaults: $25 / 40% / $0.50.
    fn ai_limits(&self, sess: &Session) -> (f64, f64, f64) {
        let prefs: std::collections::HashMap<String, String> = self.users.lock().unwrap().prefs(sess).unwrap_or_default().into_iter().collect();
        let f = |k: &str, d: f64| prefs.get(k).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(d);
        (f("ai_budget_usd", 25.0), f("ai_index_share_pct", 40.0).min(100.0) / 100.0, f("ai_max_request_usd", 0.50))
    }

    fn price_for(&self, provider: Provider, model: &str, prompt_tokens: u64) -> crate::pricing::Quote {
        let day = &auth::now()[..10];
        let ov = self.users.lock().unwrap().policy(&format!("price:{model}")).ok().flatten().and_then(|v| {
            let (i, o) = v.split_once(',')?;
            Some((i.trim().parse().ok()?, o.trim().parse().ok()?))
        });
        crate::pricing::quote(provider, model, day, prompt_tokens, ov)
    }

    /// Every AI call goes through here. Before: the worst case (estimated
    /// input + the longest answer allowed, at the model's price) must fit the
    /// per-request limit and what's left of this month's budget for that kind
    /// of use, and is held. After: the real cost from the provider's usage
    /// report is recorded and the hold released.
    #[allow(clippy::too_many_arguments)]
    pub fn ai_call(&self, feature: &'static str, choice: &AiChoice, key: &str, system: &str, msgs: &[ai::Msg], max_tokens: u32, cancel: &dyn Fn() -> bool, on_delta: &mut dyn FnMut(&str)) -> Result<(ai::ChatResult, f64), ai::AiError> {
        let deny = |m: String| ai::AiError { message: m, status: Some(402) };
        let (uid, (budget, index_share, max_request)) = self
            .with_session(|s| Ok((s.user.id, self.ai_limits(s))))
            .map_err(|e| ai::AiError { message: e.message, status: Some(e.code) })?;
        let chars = system.len() + msgs.iter().map(|m| m.content.len()).sum::<usize>();
        let est_in = crate::pricing::estimate_tokens(chars);
        let max_out = ai::effective_max_tokens(choice, max_tokens) as u64;
        let q = self.price_for(choice.provider, &choice.model, est_in);
        let worst = crate::pricing::worst_case(&q.price, est_in, max_out);
        if worst > max_request {
            return Err(deny(format!(
                "This request could cost up to ${worst:.2}, over your per-request limit of ${max_request:.2}. Use a cheaper model or raise the limit in Profile › AI › Spending."
            )));
        }
        let month = auth::now()[..7].to_string();
        let (spent_q, spent_i, held, _) = self.users.lock().unwrap().ai_month(uid, &month).map_err(|e| deny(e.0))?;
        let (cap, spent, label) = if feature == "index" { (budget * index_share, spent_i, "AI reading of documents") } else { (budget * (1.0 - index_share), spent_q, "questions") };
        let left = cap - spent - held;
        if worst > left {
            return Err(deny(format!(
                "This would go over your AI budget: it could cost up to ${worst:.2}, and ${:.2} is left of ${cap:.2} for {label} this month (resets on the 1st). Raise the budget in Profile › AI › Spending.",
                left.max(0.0)
            )));
        }
        let note = q.note.clone().unwrap_or_default();
        let id = self.users.lock().unwrap().ai_reserve(uid, &month, feature, choice.provider.as_str(), &choice.model, worst, &note).map_err(|e| deny(e.0))?;
        match ai::chat(choice, key, system, msgs, max_tokens, cancel, on_delta) {
            Ok(r) => {
                let qa = self.price_for(choice.provider, &r.model, r.input_tokens + r.cache_read_tokens + r.cache_write_tokens);
                let cost = crate::pricing::cost(&qa.price, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens);
                let _ = self.users.lock().unwrap().ai_settle(id, &r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, cost, "charged", None);
                self.platform.emit("ai_spend", json!({"feature": feature, "cost_usd": cost}));
                Ok((r, cost))
            }
            Err(e) => {
                // The provider refused it (HTTP error): nothing billed. The
                // connection dropped mid-answer: charge the input estimate.
                let (status, cost, note) = if e.status.is_some() {
                    ("released", 0.0, "Provider returned an error; not billed")
                } else {
                    ("uncertain", est_in as f64 * q.price.input / 1_000_000.0, "Connection dropped; charged the estimated input cost")
                };
                let _ = self.users.lock().unwrap().ai_settle(id, &choice.model, 0, 0, 0, 0, cost, status, Some(note));
                Err(e)
            }
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
        let dir = self.paths.local.join("index");
        let work = dir.join("work.db");
        if let Err(e) = self.guard.create_dir_all(&dir) {
            return self.scan_fail(&format!("Could not create {}: {e}", dir.display()));
        }
        let _ = self.guard.remove_own_file(&work);
        if let Some(src) = self.active_db.read().unwrap().clone() {
            self.scan_log("Copying the current index to a working copy…");
            if let Err(e) = self.guard.copy_into(&src, &work) {
                return self.scan_fail(&format!("Could not copy the index: {e}"));
            }
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
        let opts = crate::crawl::Options { workers, cancel: self.scan_cancel.clone() };
        let mut total = crate::crawl::Progress::default();
        for root in &roots {
            self.scan_log(format!("Scanning {root} with {workers} parallel readers (read-only)…"));
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
        let team = self.config.read().unwrap().team_folder.clone();
        if let Some(t) = team {
            self.scan_log(format!("Publishing to the team folder {t}…"));
            if let Err(e) = self.guard.publish(&local, &PathBuf::from(&t).join("index").join("thor_knowledge.db")) {
                self.scan_log(format!("Could not publish to the team folder ({e}); this PC uses the new index anyway."));
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

    fn audit(&self, action: &str, detail: &str) {
        let who = self.session.lock().unwrap().as_ref().map(|s| s.user.email.clone());
        let _ = self.users.lock().unwrap().audit(who.as_deref(), action, detail);
    }

    /// The key for an AI call: one typed in the wizard (not yet saved), or the
    /// user's own saved key. AI is for administrator profiles only; also
    /// enforces the team AI switch and allowed providers.
    fn ai_key_for(&self, a: &Value) -> Result<(Provider, zeroize::Zeroizing<String>), ApiError> {
        let provider = Provider::parse(&s(a, "provider")).ok_or_else(|| ApiError::new(400, "Choose a provider."))?;
        self.with_session(|sess| {
            let users = self.users.lock().unwrap();
            if users.policy("ai_enabled")?.map(|v| v == "false").unwrap_or(false) {
                return Err(ApiError::new(403, "AI features are turned off by your administrator."));
            }
            if !sess.is_admin() {
                return Err(ApiError::new(403, "AI features are available to administrator profiles only."));
            }
            if !sess.user.can_ai {
                return Err(ApiError::new(403, "AI is turned off for your profile."));
            }
            let allowed = users.policy("ai_providers")?.unwrap_or_else(|| "anthropic,openai,gemini".into());
            if !allowed.split(',').any(|p| p == provider.as_str()) {
                return Err(ApiError::new(403, "Your administrator has not allowed this provider."));
            }
            if let Some(k) = a.get("key").and_then(|k| k.as_str()).filter(|k| !k.trim().is_empty()) {
                return Ok((provider, zeroize::Zeroizing::new(k.trim().to_string())));
            }
            match users.get_secret(sess, "ai_key")? {
                Some(k) => Ok((provider, k)),
                None => Err(ApiError::new(400, "Paste your API key first.")),
            }
        })
    }

    pub fn current_ai(&self) -> Result<(AiChoice, zeroize::Zeroizing<String>), ApiError> {
        self.with_session(|sess| {
            if !sess.is_admin() {
                return Err(ApiError::new(403, "AI features are available to administrator profiles only."));
            }
            let users = self.users.lock().unwrap();
            let prefs: std::collections::HashMap<String, String> = users.prefs(sess)?.into_iter().collect();
            let provider = prefs.get("ai_provider").and_then(|p| Provider::parse(p)).ok_or_else(|| ApiError::new(400, "Set up AI first (Profile › AI)."))?;
            let model = prefs.get("ai_model").cloned().unwrap_or_default();
            let reasoning = prefs.get("ai_reasoning").cloned().filter(|r| !r.is_empty());
            drop(users);
            Ok((provider, model, reasoning))
        })
        .and_then(|(provider, model, reasoning)| {
            let (_, key) = self.ai_key_for(&json!({"provider": provider.as_str()}))?;
            Ok((AiChoice { provider, model, reasoning }, key))
        })
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

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.chat_cancel
    }

    pub fn about(&self) -> Value {
        json!({
            "version": VERSION,
            "local_data": self.paths.local.display().to_string(),
            "temp": self.paths.temp.display().to_string(),
            "profiles": self.profiles_path.display().to_string(),
            "team_folder": self.config.read().unwrap().team_folder,
            "protected_roots": self.guard.protected_roots(),
            "writable": self.guard.writable_dirs(),
            "index": self.index_state.read().unwrap().clone(),
            "ai_hosts": ai::providers().iter().map(|p| p.host).collect::<Vec<_>>(),
            "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
            "machine": self.platform.machine(),
        })
    }
}
