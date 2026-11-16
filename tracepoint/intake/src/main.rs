//! Scan Intake for Windows: one portable exe. A native window hosts
//! Windows' built-in WebView2 for the interface (embedded in this file),
//! which talks to the intake service through a private URL scheme.
//! Per-user settings live in %LOCALAPPDATA%\Scan Intake; the ledger and
//! originals live on the scan drive.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod win {
    use intake::service::{Platform, Service};
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
    use tao::window::{Icon, WindowBuilder};
    use wry::http::{header::CONTENT_TYPE, Request, Response};
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    static UI_HTML: &str = include_str!("../../ui/dist-intake/intake.html");
    static ICON_PNG: &[u8] = include_bytes!("../../assets/mark512.png");
    /// PDFium (BSD-3): opens, renders and splits PDFs.
    static PDFIUM_DLL: &[u8] = include_bytes!("../../assets/pdfium.dll");
    const ORIGIN: &str = "http://intake.localhost";

    enum UserEvent {
        Script(String),
    }

    struct WinPlatform {
        proxy: Mutex<EventLoopProxy<UserEvent>>,
    }

    fn wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn message_box(title: &str, text: &str) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        unsafe {
            MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | MB_ICONERROR);
        }
    }

    impl Platform for WinPlatform {
        fn open_path(&self, p: &Path) -> Result<(), String> {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
            let r = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(&p.to_string_lossy()).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
            if (r as isize) <= 32 {
                return Err(format!("Windows could not open {}.", p.display()));
            }
            Ok(())
        }
        fn reveal(&self, p: &Path) -> Result<(), String> {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", p.display())).spawn().map(|_| ()).map_err(|e| e.to_string())
        }
        fn pick_folder(&self, title: &str) -> Option<PathBuf> {
            rfd::FileDialog::new().set_title(title).pick_folder()
        }
        fn emit(&self, event: &str, payload: Value) {
            let js = format!("window.__tp_emit && window.__tp_emit({}, {});", serde_json::to_string(event).unwrap(), payload);
            let _ = self.proxy.lock().unwrap().send_event(UserEvent::Script(js));
        }
    }

    fn respond(status: u16, ct: &str, body: Vec<u8>) -> Response<Vec<u8>> {
        Response::builder().status(status).header(CONTENT_TYPE, ct).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").body(body).unwrap()
    }

    fn route(svc: &Arc<Service>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let path = req.uri().path().to_string();
        if let Some(cmd) = path.strip_prefix("/api/") {
            let a: Value = serde_json::from_slice(req.body()).unwrap_or(json!({}));
            return match svc.handle(cmd, &a) {
                Ok(v) => respond(200, "application/json", v.to_string().into_bytes()),
                Err(e) => respond(e.code, "application/json", json!({"error": e.message}).to_string().into_bytes()),
            };
        }
        if let Some(rest) = path.strip_prefix("/page/") {
            let mut it = rest.split('/');
            let id = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let n = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            return match svc.page_image(id, n) {
                Some(b) => respond(200, "image/jpeg", b),
                None => respond(404, "text/plain", Vec::new()),
            };
        }
        let mut r = respond(200, "text/html; charset=utf-8", UI_HTML.as_bytes().to_vec());
        r.headers_mut().insert(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'".parse().unwrap(),
        );
        r
    }

    fn local_data_dir() -> PathBuf {
        std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir()).join("Scan Intake")
    }

    pub fn run() {
        if std::env::args().any(|a| a == "--version") {
            use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
            unsafe {
                AttachConsole(ATTACH_PARENT_PROCESS);
            }
            println!("Scan Intake {}", intake::service::VERSION);
            return;
        }
        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
        let proxy = event_loop.create_proxy();
        let local = local_data_dir();
        let svc = Service::new(Box::new(WinPlatform { proxy: Mutex::new(proxy) }), local.clone());
        {
            use sha2::{Digest, Sha256};
            let dll = local.join("bin").join("pdfium-159.0.8149.dll");
            let want = Sha256::digest(PDFIUM_DLL);
            let ok = std::fs::read(&dll).map(|b| Sha256::digest(&b) == want).unwrap_or(false);
            if !ok {
                let _ = std::fs::create_dir_all(dll.parent().unwrap());
                let _ = std::fs::write(&dll, PDFIUM_DLL);
            }
            svc.set_pdfium(&dll);
        }
        {
            // OCR engine on its own thread (WinRT initialisation).
            let s = svc.clone();
            std::thread::spawn(move || s.set_ocr(intake::ocr::system_ocr()));
        }
        svc.start();

        let icon = image::load_from_memory(ICON_PNG).ok().map(|i| i.to_rgba8()).and_then(|i| {
            let (w, h) = i.dimensions();
            Icon::from_rgba(i.into_raw(), w, h).ok()
        });
        let window = WindowBuilder::new()
            .with_title("Scan Intake")
            .with_window_icon(icon)
            .with_inner_size(LogicalSize::new(1400.0, 900.0))
            .with_min_inner_size(LogicalSize::new(1050.0, 650.0))
            .with_maximized(true)
            .build(&event_loop)
            .expect("window");
        let mut ctx = WebContext::new(Some(local.join("WebView2")));
        let handler_svc = svc.clone();
        let webview = WebViewBuilder::new_with_web_context(&mut ctx)
            .with_url(format!("{ORIGIN}/"))
            .with_background_color((243, 245, 249, 255))
            .with_devtools(cfg!(debug_assertions))
            .with_asynchronous_custom_protocol("intake".into(), move |_id, request, responder| {
                let svc = handler_svc.clone();
                std::thread::spawn(move || responder.respond(route(&svc, request)));
            })
            .with_navigation_handler(|url| url.starts_with(ORIGIN) || url.starts_with("about:") || url.starts_with("data:"))
            .with_new_window_req_handler(|_url, _features| NewWindowResponse::Deny)
            .with_download_started_handler(|_url, _path| false)
            .build(&window);
        let webview = match webview {
            Ok(w) => w,
            Err(e) => {
                message_box("Scan Intake needs Microsoft Edge WebView2", &format!("Scan Intake draws its window with the Microsoft Edge WebView2 Runtime, which is part of Windows 10 and 11 but appears to be missing on this PC.\n\nAsk IT to install the \"Microsoft Edge WebView2 Runtime (Evergreen)\".\n\nDetails: {e}"));
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
}

fn main() {
    #[cfg(windows)]
    win::run();
    #[cfg(not(windows))]
    eprintln!("Scan Intake runs on Windows. For development use the intake-dev server.");
}
