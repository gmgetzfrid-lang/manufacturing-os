//! TracePoint for Windows: one portable exe.
//!
//! A native window hosts Windows' built-in WebView2 to draw the interface,
//! which is embedded in this file. No THOR data is inside the exe. The
//! interface talks to the Rust service through a private `tp` URL scheme that
//! exists only inside this window. Nothing is installed; per-user data goes to
//! %LOCALAPPDATA%\TracePoint.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Icon, WindowBuilder};
use tp_core::service::{Platform, Service};
use wry::http::{header::CONTENT_TYPE, Request, Response};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

static UI_HTML: &str = include_str!("../../ui/dist/index.html");
static ICON_PNG: &[u8] = include_bytes!("../../assets/mark512.png");
/// PDFium 157.0.8100 (BSD-3, from github.com/bblanchon/pdfium-binaries):
/// reads PDF text and renders scanned pages for OCR.
static PDFIUM_DLL: &[u8] = include_bytes!("../../assets/pdfium.dll");

const ORIGIN: &str = "http://tp.localhost";

enum UserEvent {
    Script(String),
}

struct WinPlatform {
    proxy: Mutex<EventLoopProxy<UserEvent>>,
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn message_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    unsafe {
        MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | MB_ICONERROR);
    }
}
#[cfg(not(windows))]
fn message_box(title: &str, text: &str) {
    eprintln!("{title}: {text}");
}

/// T: -> \\server\share for mapped network drives, so the THOR guard also
/// recognises drive-letter paths.
#[cfg(windows)]
fn resolve_drive(drive: &str) -> Option<String> {
    use windows_sys::Win32::NetworkManagement::WNet::WNetGetConnectionW;
    let mut buf = vec![0u16; 1024];
    let mut len: u32 = buf.len() as u32;
    let d = wide(&drive.to_uppercase());
    let rc = unsafe { WNetGetConnectionW(d.as_ptr(), buf.as_mut_ptr(), &mut len) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

impl Platform for WinPlatform {
    fn open_path(&self, p: &Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
            let r = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(&p.to_string_lossy()).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
            if (r as isize) <= 32 {
                return Err(format!("Windows could not open {} (no program is associated with this file type, or the file is unavailable).", p.display()));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = p;
            Err("Opening files is only supported on Windows".into())
        }
    }

    fn reveal(&self, p: &Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{}\"", p.display()))
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(windows))]
        {
            let _ = p;
            Err("Not supported".into())
        }
    }

    fn save_dialog(&self, title: &str, default_name: &str, ext: &str) -> Option<PathBuf> {
        let docs = std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join("Documents")).ok();
        let mut d = rfd::FileDialog::new().set_title(title).set_file_name(default_name).add_filter(ext.to_uppercase(), &[ext]);
        if let Some(dir) = docs {
            d = d.set_directory(dir);
        }
        d.save_file()
    }

    fn open_dialog(&self, title: &str, ext: &str) -> Option<PathBuf> {
        rfd::FileDialog::new().set_title(title).add_filter(ext.to_uppercase(), &[ext]).pick_file()
    }

    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        rfd::FileDialog::new().set_title(title).pick_folder()
    }

    fn emit(&self, event: &str, payload: Value) {
        let js = format!("window.__tp_emit && window.__tp_emit({}, {});", serde_json::to_string(event).unwrap(), payload);
        let _ = self.proxy.lock().unwrap().send_event(UserEvent::Script(js));
    }

    fn exe_dir(&self) -> Option<PathBuf> {
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
    }

    fn drive_resolver(&self) -> Option<tp_core::guard::DriveResolver> {
        #[cfg(windows)]
        {
            Some(resolve_drive)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

fn local_data_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir()).join("TracePoint")
}

fn respond(status: u16, ct: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, ct)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap()
}

/// Routes for the private tp:// scheme.
fn route(svc: &Arc<Service>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    if let Some(cmd) = path.strip_prefix("/api/") {
        let a: Value = serde_json::from_slice(req.body()).unwrap_or(json!({}));
        return match svc.handle(cmd, &a) {
            Ok(v) => respond(200, "application/json", v.to_string().into_bytes()),
            Err(e) => respond(e.code, "application/json", json!({"error": e.message}).to_string().into_bytes()),
        };
    }
    if let Some(id) = path.strip_prefix("/file/") {
        let as_ = query.split('&').find_map(|kv| kv.strip_prefix("as=")).unwrap_or("");
        return match svc.serve_file(id.parse().unwrap_or(u32::MAX), as_) {
            Ok((ct, bytes)) => respond(200, &ct, bytes),
            Err(e) => respond(e.code, "text/plain; charset=utf-8", e.message.into_bytes()),
        };
    }
    if let Some(name) = path.strip_prefix("/asset/") {
        return match Service::serve_asset(name) {
            Some((ct, b)) => respond(200, ct, b.to_vec()),
            None => respond(404, "text/plain", Vec::new()),
        };
    }
    if path == "/events" {
        // Events are pushed by script in the app; nothing to stream here.
        return respond(204, "text/plain", Vec::new());
    }
    // Defence in depth: the window may only load TracePoint's own content.
    let mut r = respond(200, "text/html; charset=utf-8", UI_HTML.as_bytes().to_vec());
    r.headers_mut().insert(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
            .parse()
            .unwrap(),
    );
    r
}

#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
#[cfg(not(windows))]
fn attach_console() {}

fn selftest() -> i32 {
    attach_console();
    println!();
    println!("TracePoint {} self-test", tp_core::service::VERSION);
    println!("Executable: {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default());
    println!();
    let mut checks = tp_core::selftest::run(&[]);
    // The PDF engine is checked from a temporary copy, removed afterwards.
    let dll = std::env::temp_dir().join(format!("TracePoint-selftest-pdfium-{}.dll", std::process::id()));
    if std::fs::write(&dll, PDFIUM_DLL).is_ok() {
        checks.extend(tp_core::selftest::run_content(Some(&dll)));
    }
    let mut failed = 0;
    for c in &checks {
        println!("{}  {:<48} {}", if c.ok { "PASS" } else { "FAIL" }, c.name, c.detail);
        if !c.ok {
            failed += 1;
        }
    }
    println!();
    let _ = std::fs::remove_file(&dll);
    println!("{} checks, {} failed. Nothing was written to THOR.", checks.len(), failed);
    if failed == 0 { 0 } else { 1 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest" || a == "/selftest") {
        std::process::exit(selftest());
    }
    if args.iter().any(|a| a == "--version") {
        attach_console();
        println!("TracePoint {}", tp_core::service::VERSION);
        return;
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let local = local_data_dir();

    let svc = match Service::new(Box::new(WinPlatform { proxy: Mutex::new(proxy) }), local.clone()) {
        Ok(s) => s,
        Err(e) => {
            message_box("TracePoint could not start", &format!("{e}\n\nTracePoint keeps its data in {}.", local.display()));
            std::process::exit(1);
        }
    };
    // Unpack the PDF engine next to TracePoint's data, and make sure the copy
    // on disk is byte-for-byte the one inside this exe before every use.
    {
        use sha2::{Digest, Sha256};
        let dll = local.join("bin").join("pdfium-157.0.8100.dll");
        let want = Sha256::digest(PDFIUM_DLL);
        let ok = std::fs::read(&dll).map(|b| Sha256::digest(&b) == want).unwrap_or(false);
        if ok || svc.guard.write(&dll, PDFIUM_DLL).is_ok() {
            svc.set_pdfium(dll);
        }
    }
    {
        let s = svc.clone();
        std::thread::spawn(move || s.load_index());
    }
    svc.watch_team();

    let icon = image::load_from_memory(ICON_PNG).ok().map(|i| i.to_rgba8()).and_then(|i| {
        let (w, h) = i.dimensions();
        Icon::from_rgba(i.into_raw(), w, h).ok()
    });
    let window = WindowBuilder::new()
        .with_title("TracePoint")
        .with_window_icon(icon)
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(1100.0, 680.0))
        .with_maximized(true)
        .build(&event_loop)
        .expect("window");

    // WebView2's own profile goes to LocalAppData, never next to the exe
    // (which may live on a read-only share).
    let mut ctx = WebContext::new(Some(local.join("WebView2")));
    let handler_svc = svc.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(format!("{ORIGIN}/"))
        .with_background_color((243, 245, 249, 255))
        .with_devtools(cfg!(debug_assertions))
        .with_asynchronous_custom_protocol("tp".into(), move |_id, request, responder| {
            let svc = handler_svc.clone();
            std::thread::spawn(move || responder.respond(route(&svc, request)));
        })
        // Only TracePoint's own pages; no browsing, pop-ups or downloads.
        .with_navigation_handler(|url| url.starts_with(ORIGIN) || url.starts_with("about:") || url.starts_with("data:"))
        .with_new_window_req_handler(|_url, _features| NewWindowResponse::Deny)
        .with_download_started_handler(|_url, _path| false)
        .build(&window);
    let webview = match webview {
        Ok(w) => w,
        Err(e) => {
            message_box(
                "TracePoint needs Microsoft Edge WebView2",
                &format!(
                    "TracePoint draws its window with the Microsoft Edge WebView2 Runtime, which is part of Windows 10 and 11 but appears to be missing or blocked on this PC.\n\nAsk IT to install the \"Microsoft Edge WebView2 Runtime (Evergreen)\".\n\nDetails: {e}"
                ),
            );
            std::process::exit(2);
        }
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Script(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
