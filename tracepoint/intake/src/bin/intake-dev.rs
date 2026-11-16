//! Development server: the same service over plain HTTP on 127.0.0.1, for
//! working on the interface and testing outside Windows.
//!   INTAKE_PDFIUM=/path/libpdfium.so intake-dev [port] [local-data-dir]

use intake::service::{Platform, Service};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct DevPlatform {
    events: Arc<Mutex<Vec<String>>>,
}

impl Platform for DevPlatform {
    fn open_path(&self, p: &Path) -> Result<(), String> {
        eprintln!("open {}", p.display());
        Ok(())
    }
    fn reveal(&self, p: &Path) -> Result<(), String> {
        eprintln!("reveal {}", p.display());
        Ok(())
    }
    fn pick_folder(&self, _title: &str) -> Option<PathBuf> {
        None
    }
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push(json!({"name": event, "payload": payload}).to_string());
    }
}

/// Stand-in OCR for testing the text layer off Windows: one line of three
/// words near the top-left of every page.
struct FakeOcr;
impl intake::ocr::Ocr for FakeOcr {
    fn max_side(&self) -> u32 {
        2600
    }
    fn recognize(&self, img: &image::RgbaImage) -> Result<Vec<Vec<intake::ocr::Word>>, String> {
        let (w, h) = img.dimensions();
        let (fw, fh) = (w as f32, h as f32);
        let words = ["SCANNED", "TEXT", "LAYER"]
            .iter()
            .enumerate()
            .map(|(i, t)| intake::ocr::Word { text: t.to_string(), x: fw * (0.1 + 0.15 * i as f32), y: fh * 0.1, w: fw * 0.12, h: fh * 0.02 })
            .collect();
        Ok(vec![words])
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args.get(1).cloned().unwrap_or_else(|| "7979".into());
    let local = PathBuf::from(args.get(2).cloned().unwrap_or_else(|| std::env::temp_dir().join("intake-dev").display().to_string()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let svc = Service::new(Box::new(DevPlatform { events: events.clone() }), local);
    if let Ok(p) = std::env::var("INTAKE_PDFIUM") {
        svc.set_pdfium(Path::new(&p));
    }
    if std::env::var("INTAKE_FAKE_OCR").is_ok() {
        svc.set_ocr(Some(Box::new(FakeOcr)));
    } else {
        svc.set_ocr(None);
    }
    svc.start();
    let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../ui/dist-intake/intake.html")).unwrap_or_else(|_| "<p>Build the UI first (npm run build:intake)</p>".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    eprintln!("Scan Intake dev server on http://127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        let svc = svc.clone();
        let ui = ui.clone();
        std::thread::spawn(move || {
            let mut s = stream;
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            if r.read_line(&mut line).is_err() {
                return;
            }
            let mut parts = line.split_whitespace();
            let _method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("/").split('?').next().unwrap_or("/").to_string();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            let _ = r.read_exact(&mut body);
            let (status, ct, out): (u16, &str, Vec<u8>) = if let Some(cmd) = path.strip_prefix("/api/") {
                let a: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
                match svc.handle(cmd, &a) {
                    Ok(v) => (200, "application/json", v.to_string().into_bytes()),
                    Err(e) => (e.code, "application/json", json!({"error": e.message}).to_string().into_bytes()),
                }
            } else if let Some(rest) = path.strip_prefix("/page/") {
                let mut it = rest.split('/');
                let id = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                let n = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                match svc.page_image(id, n) {
                    Some(b) => (200, "image/jpeg", b),
                    None => (404, "text/plain", vec![]),
                }
            } else if path == "/events" {
                (204, "text/plain", vec![])
            } else {
                (200, "text/html; charset=utf-8", ui.into_bytes())
            };
            let _ = write!(s, "HTTP/1.1 {status} OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", out.len());
            let _ = s.write_all(&out);
        });
    }
}
