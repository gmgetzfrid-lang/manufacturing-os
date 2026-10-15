//! tpserve --data <dir> [--ui <dist/index.html>] [--port 7878]
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use tp_core::service::{Platform, Service};

struct DevPlatform {
    subscribers: Arc<Mutex<Vec<mpsc::Sender<String>>>>,
}

impl Platform for DevPlatform {
    fn open_path(&self, p: &Path) -> Result<(), String> {
        eprintln!("[open] {}", p.display());
        Ok(())
    }
    fn reveal(&self, p: &Path) -> Result<(), String> {
        eprintln!("[reveal] {}", p.display());
        Ok(())
    }
    fn save_dialog(&self, _t: &str, name: &str, _e: &str) -> Option<PathBuf> {
        Some(std::env::temp_dir().join("TracePoint").join(name))
    }
    fn open_dialog(&self, _t: &str, _e: &str) -> Option<PathBuf> {
        std::env::var("TP_OPEN").ok().map(PathBuf::from)
    }
    fn pick_folder(&self, _t: &str) -> Option<PathBuf> {
        std::env::var("TP_FOLDER").ok().map(PathBuf::from)
    }
    fn emit(&self, event: &str, payload: Value) {
        let msg = json!({"name": event, "payload": payload}).to_string();
        self.subscribers.lock().unwrap().retain(|s| s.send(msg.clone()).is_ok());
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let data = PathBuf::from(get("--data").expect("--data <dir>"));
    let ui = get("--ui").map(PathBuf::from);
    let port = get("--port").unwrap_or_else(|| "7878".into());
    let snapshot: Option<&'static [u8]> = get("--snapshot").map(|p| &*Box::leak(std::fs::read(p).unwrap().into_boxed_slice()));
    let subs = Arc::new(Mutex::new(Vec::new()));
    let svc = Service::new(Box::new(DevPlatform { subscribers: subs.clone() }), data, snapshot).unwrap();
    {
        let s = svc.clone();
        std::thread::spawn(move || s.load_index());
    }
    let server = Arc::new(tiny_http::Server::http(format!("127.0.0.1:{port}")).unwrap());
    eprintln!("tpserve on http://127.0.0.1:{port}");
    let mut workers = Vec::new();
    for _ in 0..8 {
        let server = server.clone();
        let svc = svc.clone();
        let ui = ui.clone();
        let subs = subs.clone();
        workers.push(std::thread::spawn(move || loop {
            let Ok(mut req) = server.recv() else { break };
            let url = req.url().to_string();
            let (path, query) = url.split_once('?').unwrap_or((&url, ""));
            let header = |ct: &str| tiny_http::Header::from_bytes("Content-Type", ct).unwrap();
            if let Some(cmd) = path.strip_prefix("/api/") {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let a: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                let (code, out) = match svc.handle(cmd, &a) {
                    Ok(v) => (200, v),
                    Err(e) => (e.code, json!({"error": e.message})),
                };
                let _ = req.respond(tiny_http::Response::from_string(out.to_string()).with_status_code(code).with_header(header("application/json")));
            } else if let Some(id) = path.strip_prefix("/file/") {
                let as_ = query.strip_prefix("as=").unwrap_or("");
                match svc.serve_file(id.parse().unwrap_or(u32::MAX), as_) {
                    Ok((ct, bytes)) => { let _ = req.respond(tiny_http::Response::from_data(bytes).with_header(header(&ct))); }
                    Err(e) => { let _ = req.respond(tiny_http::Response::from_string(e.message).with_status_code(e.code)); }
                }
            } else if let Some(name) = path.strip_prefix("/asset/") {
                match Service::serve_asset(name) {
                    Some((ct, b)) => { let _ = req.respond(tiny_http::Response::from_data(b.to_vec()).with_header(header(ct))); }
                    None => { let _ = req.respond(tiny_http::Response::empty(404)); }
                }
            } else if path == "/events" {
                let (tx, rx) = mpsc::channel::<String>();
                subs.lock().unwrap().push(tx);
                struct SseReader { rx: mpsc::Receiver<String>, buf: Vec<u8> }
                impl Read for SseReader {
                    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                        while self.buf.is_empty() {
                            match self.rx.recv_timeout(std::time::Duration::from_secs(15)) {
                                Ok(m) => self.buf = format!("data: {m}\n\n").into_bytes(),
                                Err(mpsc::RecvTimeoutError::Timeout) => self.buf = b": ping\n\n".to_vec(),
                                Err(_) => return Ok(0),
                            }
                        }
                        let n = out.len().min(self.buf.len());
                        out[..n].copy_from_slice(&self.buf[..n]);
                        self.buf.drain(..n);
                        Ok(n)
                    }
                }
                let resp = tiny_http::Response::new(200.into(), vec![header("text/event-stream")], SseReader { rx, buf: Vec::new() }, None, None);
                let _ = req.respond(resp);
            } else {
                match &ui {
                    Some(p) => { let _ = req.respond(tiny_http::Response::from_data(std::fs::read(p).unwrap_or_default()).with_header(header("text/html; charset=utf-8"))); }
                    None => { let _ = req.respond(tiny_http::Response::from_string("UI not configured").with_status_code(404)); }
                }
            }
        }));
    }
    for w in workers { let _ = w.join(); }
}
