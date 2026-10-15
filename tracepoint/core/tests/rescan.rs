//! Rescan end to end: an administrator scans a folder; the new index is
//! saved through the guard, loaded into search, and nothing is written to
//! the scanned folder.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tp_core::service::{Platform, Service};

struct Quiet;
impl Platform for Quiet {
    fn open_path(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn reveal(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn save_dialog(&self, _: &str, _: &str, _: &str) -> Option<PathBuf> { None }
    fn open_dialog(&self, _: &str, _: &str) -> Option<PathBuf> { None }
    fn pick_folder(&self, _: &str) -> Option<PathBuf> { None }
    fn emit(&self, _: &str, _: Value) {}
}

fn snapshot(dir: &Path) -> Vec<(String, u64)> {
    let mut v = Vec::new();
    for e in walk(dir) {
        let m = std::fs::metadata(&e).unwrap();
        v.push((e.display().to_string(), m.len()));
    }
    v.sort();
    v
}
fn walk(d: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(d).unwrap().flatten() {
        if e.path().is_dir() { out.extend(walk(&e.path())); } else { out.push(e.path()); }
    }
    out
}

#[test]
fn admin_rescan_builds_and_loads_index() {
    let base = std::env::temp_dir().join(format!("tp-rescan-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let thor = base.join("thor");
    let v2 = thor.join("5600 - LRU/10 - VESSELS/5610.15 V-2 Suction Bottle/INSPECTIONS/2023 EXT");
    std::fs::create_dir_all(&v2).unwrap();
    std::fs::write(v2.join("Bottle EXT INSPECTION REPORT.pdf"), b"%PDF").unwrap();
    // A "scan": a PDF page with no text layer (and no OCR on this host).
    std::fs::write(v2.join("5610.15 U-1A scan.pdf"), tp_core::content::minimal_pdf("")).unwrap();
    std::fs::write(v2.join("Field Notes.pdf"), tp_core::content::minimal_pdf("Minimum thickness readings at nozzle N3 were 0.312 inch, below t-min")).unwrap();
    let before = snapshot(&thor);

    let svc = Service::new(Box::new(Quiet), base.join("local"), None).unwrap();
    let pdfium = std::env::var("TP_PDFIUM").ok();
    if let Some(p) = &pdfium {
        svc.set_pdfium(PathBuf::from(p));
    }
    svc.handle("auth.login", &json!({"email": "ggetzfrid@kernenergy.com", "password": "password"})).unwrap();
    svc.handle("auth.change_password", &json!({"current": "password", "new": "Refinery#Search2026"})).unwrap();
    // Windows-style path, as on THOR (the dev scanner maps \\ back to /).
    let root = thor.display().to_string().replace('/', "\\");
    svc.handle("indexer.start", &json!({"root": root, "workers": 4})).unwrap();
    let t0 = std::time::Instant::now();
    loop {
        let st = svc.handle("indexer.status", &json!({})).unwrap();
        if !st["running"].as_bool().unwrap() && st["log"].as_array().map(|l| l.iter().any(|x| x.as_str().unwrap_or("").starts_with("Done"))).unwrap_or(false) {
            assert!(st["error"].is_null(), "{st}");
            assert_eq!(st["files"], 3, "{st}");
            break;
        }
        assert!(st["error"].is_null(), "{st}");
        assert!(t0.elapsed().as_secs() < 30, "timed out: {st}");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Search sees the new files.
    let r = svc.handle("search", &json!({"query": "suction bottle inspection report", "limit": 10})).unwrap();
    assert!(r["total"].as_u64().unwrap() >= 1, "{r}");
    // After the scan, document contents are read in the background.
    if pdfium.is_some() {
        let t0 = std::time::Instant::now();
        loop {
            let st = svc.handle("content.status", &json!({})).unwrap();
            if st["phase"] == "done" {
                assert!(st["done"].as_u64().unwrap() >= 1, "{st}");
                break;
            }
            assert!(t0.elapsed().as_secs() < 30, "content timed out: {st}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // The text-less scan is staged for (optional, approved) AI reading.
        let sum = svc.handle("airead.summary", &json!({})).unwrap();
        assert_eq!(sum["staged"], 1, "{sum}");
        assert!(sum["model"].is_null(), "no AI configured yet");
        assert_eq!(svc.handle("airead.start", &json!({"count": 1})).unwrap_err().code, 400, "needs AI setup first");
        let r = svc.handle("search", &json!({"query": "t-min nozzle N3 thickness 0.312", "limit": 10})).unwrap();
        let inside = r["inside"].as_array().cloned().unwrap_or_default();
        let listed = r["hits"].as_array().unwrap().iter().any(|h| h["snippet"].is_string());
        assert!(!inside.is_empty() || listed, "{r}");
        // Ask THOR's pipeline end to end, with a stand-in for the AI.
        let e = svc.current_engine().unwrap();
        let ai = tp_core::ai::AiChoice { provider: tp_core::ai::Provider::Anthropic, model: "claude-test".into(), reasoning: None };
        let calls = std::cell::RefCell::new(Vec::<String>::new());
        let fake = |_c: &tp_core::ai::AiChoice, system: &str, msgs: &[tp_core::ai::Msg], _max: u32, on: &mut dyn FnMut(&str)| {
            calls.borrow_mut().push(msgs[0].content.clone());
            let text = if system.starts_with("You generate full-text search queries") {
                if msgs[0].content.contains("zebra") { r#"["zebra mussel", "quagga"]"#.to_string() } else { r#"["minimum thickness nozzle N3", "t-min nozzle"]"#.to_string() }
            } else if system.starts_with("You review passages") {
                r#"{"queries": [], "missing_documents": []}"#.to_string()
            } else {
                assert!(msgs[0].content.contains("[1] (Field Notes.pdf"), "{}", msgs[0].content);
                "**Answer:** Nozzle N3 measured `0.312 inch`, below t-min [1].\n**Basis:**\n- Field notes: readings at N3 were **0.312** [1] [7]\n**Check:** confirm on page 1.".to_string()
            };
            on(&text);
            Ok(tp_core::ai::ChatResult { text, model: "claude-test".into(), input_tokens: 100, output_tokens: 50, ..Default::default() })
        };
        let out = tp_core::ask::ask(&e, &ai, &ai, &fake, "what were the readings at nozzle N3?", &[], None, &|_| {}, &|_| {}, &mut |_| {}).unwrap();
        assert_eq!(out.cited, vec![1], "{}", out.answer);
        assert!(out.answer.contains("pointed to passages that don't exist"), "[7] is out of range and must be flagged");
        assert_eq!(out.passages[0].name, "Field Notes.pdf");
        assert_eq!(calls.borrow().len(), 3, "rewrite, refine, answer");
        // Nothing relevant: answered without the AI.
        let calls0 = calls.borrow().len();
        let none = tp_core::ask::ask(&e, &ai, &ai, &fake, "zebra mussel quagga", &[], None, &|_| {}, &|_| {}, &mut |_| {}).unwrap();
        assert!(none.answer.starts_with("**Answer:** Nothing in the documents"), "{}", none.answer);
        assert_eq!(calls.borrow().len(), calls0 + 2, "no answer call when nothing was found");
        let snip = inside.first().map(|h| h["snippet"].as_str().unwrap().to_string()).unwrap_or_default();
        assert!(snip.is_empty() || snip.contains('«'), "{snip}");
    }
    // The scanned folder is untouched.
    assert_eq!(before, snapshot(&thor));
    // A normal user can't rescan.
    svc.handle("admin.user.create", &json!({"email": "tech@kernenergy.com", "name": "Tech", "role": "user", "temp_password": "Temp-pass-77"})).unwrap();
    svc.handle("auth.logout", &json!({})).unwrap();
    svc.handle("auth.login", &json!({"email": "tech@kernenergy.com", "password": "Temp-pass-77"})).unwrap();
    svc.handle("auth.change_password", &json!({"current": "Temp-pass-77", "new": "Tank#Farm-7272"})).unwrap();
    assert_eq!(svc.handle("indexer.start", &json!({"root": root})).unwrap_err().code, 403);
    let _ = std::fs::remove_dir_all(&base);
}
