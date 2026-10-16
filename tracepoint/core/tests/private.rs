//! Private folders: only the person who added them sees them, on their PC;
//! they never reach the shared index, the shared document text or AI.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tp_core::acl::{self, Identity};
use tp_core::service::{Platform, Service};

struct Picker(PathBuf);
impl Platform for Picker {
    fn open_path(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn reveal(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn save_dialog(&self, _: &str, _: &str, _: &str) -> Option<PathBuf> { None }
    fn open_dialog(&self, _: &str, _: &str) -> Option<PathBuf> { None }
    fn pick_folder(&self, _: &str) -> Option<PathBuf> { Some(self.0.clone()) }
    fn emit(&self, _: &str, _: Value) {}
}

fn wait<F: Fn(&Value) -> bool>(svc: &Arc<Service>, cmd: &str, done: F) -> Value {
    let t0 = std::time::Instant::now();
    loop {
        let st = svc.handle(cmd, &json!({})).unwrap();
        if done(&st) {
            return st;
        }
        assert!(t0.elapsed().as_secs() < 60, "timed out: {st}");
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

#[test]
fn private_folders_stay_private() {
    acl::sim::reset();
    let base = std::env::temp_dir().join(format!("tp-private-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let thor = base.join("thor/5600 - LRU/10 - VESSELS/5610.15 V-2 Receiver");
    std::fs::create_dir_all(&thor).unwrap();
    std::fs::write(thor.join("5610.15 UT Survey 2022.pdf"), tp_core::content::minimal_pdf("thickness survey")).unwrap();
    let mine = base.join("Downloads");
    std::fs::create_dir_all(&mine).unwrap();
    std::fs::write(mine.join("My 5610.15 notes.pdf"), tp_core::content::minimal_pdf("Personal salary review and 5610.15 nozzle notes")).unwrap();

    let me = Identity::new("S-1-5-21-1-2-3-1001", "KERN\\ggetzfrid", "ggetzfrid");
    acl::sim::set_me(&me.sid, &["S-1-5-11"]);
    let svc = Service::new_as(Box::new(Picker(mine.clone())), base.join("pc"), me).unwrap();
    if let Ok(p) = std::env::var("TP_PDFIUM") {
        svc.set_pdfium(PathBuf::from(p));
    }
    let team = base.join("TP/TracePoint Data");
    std::fs::create_dir_all(base.join("TP")).unwrap();
    svc.handle("team.setup", &json!({"path": team.display().to_string()})).unwrap();
    // Shared THOR scan.
    svc.handle("indexer.start", &json!({"root": base.join("thor").display().to_string().replace('/', "\\"), "workers": 2})).unwrap();
    wait(&svc, "indexer.status", |s| !s["running"].as_bool().unwrap() && s["log"].as_array().unwrap().iter().any(|x| x.as_str().unwrap_or("").starts_with("Done")));
    wait(&svc, "content.status", |s| !s["running"].as_bool().unwrap());
    // Private folder.
    let st = svc.handle("private.add", &json!({})).unwrap();
    assert_eq!(st["running"], true, "{st}");
    wait(&svc, "indexer.status", |s| !s["running"].as_bool().unwrap() && s["log"].as_array().unwrap().iter().any(|x| x.as_str().unwrap_or("").starts_with("Done")));
    wait(&svc, "content.status", |s| !s["running"].as_bool().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(200));
    let r = svc.handle("search", &json!({"query": "5610.15", "limit": 50})).unwrap();
    let names: Vec<&str> = r["hits"].as_array().unwrap().iter().map(|h| h["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"My 5610.15 notes.pdf"), "{names:?}");
    let mine_hit = r["hits"].as_array().unwrap().iter().find(|h| h["name"] == "My 5610.15 notes.pdf").unwrap();
    assert_eq!(mine_hit["private"], true);
    let ps = svc.handle("private.status", &json!({})).unwrap();
    assert_eq!(ps["roots"].as_array().unwrap().len(), 1, "{ps}");
    // Nothing private in the shared folder, nor in the shared text, nor staged for AI.
    for f in walk(&team) {
        let raw = String::from_utf8_lossy(&std::fs::read(&f).unwrap()).to_string();
        assert!(!raw.contains("salary") && !raw.contains("My 5610.15 notes"), "leaked into {}", f.display());
    }
    for f in walk(&base.join("pc/index")) {
        let raw = String::from_utf8_lossy(&std::fs::read(&f).unwrap()).to_string();
        assert!(!raw.contains("salary"), "private text in the shared working copy {}", f.display());
    }
    // Share again: still nothing private.
    svc.handle("index.share", &json!({})).unwrap();
    for f in walk(&team) {
        assert!(!String::from_utf8_lossy(&std::fs::read(&f).unwrap()).contains("My 5610.15 notes"));
    }
    // Remove it: gone from search.
    let rid = ps["roots"][0]["root_id"].as_str().unwrap().to_string();
    svc.handle("private.remove", &json!({"root_id": rid})).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let r = svc.handle("search", &json!({"query": "5610.15", "limit": 50})).unwrap();
    assert!(!r.to_string().contains("My 5610.15 notes"));
    // The folder itself was never touched.
    assert!(mine.join("My 5610.15 notes.pdf").is_file());
    assert_eq!(std::fs::read_dir(&mine).unwrap().count(), 1);
    acl::sim::reset();
    let _ = std::fs::remove_dir_all(&base);
}

fn walk(d: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(d) {
        for e in rd.flatten() {
            if e.path().is_dir() { out.extend(walk(&e.path())); } else { out.push(e.path()); }
        }
    }
    out
}
