fn main() {
    let bytes = std::env::args().nth(1).map(|p| std::fs::read(p).unwrap());
    let checks = tp_core::selftest::run(bytes.as_deref(), &[]);
    let mut fail = 0;
    for c in &checks {
        println!("{} {:<48} {}", if c.ok { "PASS" } else { "FAIL" }, c.name, c.detail);
        if !c.ok { fail += 1; }
    }
    println!("{} checks, {} failed", checks.len(), fail);
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
