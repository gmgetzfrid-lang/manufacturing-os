// Windows resources: icon, version info, and a manifest that runs
// TracePoint as the invoking user (never asks for administrator rights),
// declares per-monitor DPI awareness and modern common controls.
fn main() {
    println!("cargo:rerun-if-changed=tracepoint.rc");
    println!("cargo:rerun-if-changed=tracepoint.manifest");
    println!("cargo:rerun-if-changed=../ui/dist/index.html");
    println!("cargo:rerun-if-changed=../assets/index.tpz");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("tracepoint.rc", embed_resource::NONE).manifest_optional().unwrap();
    }
}
