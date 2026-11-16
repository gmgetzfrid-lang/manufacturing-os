// Windows resources: icon, version info, and a manifest that runs
// Scan Intake as the invoking user (never asks for administrator rights),
// declares per-monitor DPI awareness and modern common controls.
fn main() {
    println!("cargo:rerun-if-changed=intake.rc");
    println!("cargo:rerun-if-changed=intake.manifest");
    println!("cargo:rerun-if-changed=../ui/dist-intake/intake.html");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("intake.rc", embed_resource::NONE).manifest_optional().unwrap();
    }
}
