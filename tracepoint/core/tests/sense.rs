//! Search reads a request the way a colleague would: context picks the
//! equipment, nicknames come from how people name files, and what was asked
//! about beats where a file happens to be filed.

use rusqlite::Connection;
use tp_core::engine::{Engine, SearchRequest, SearchResponse};
use tp_core::index::Index;

const ROOT: &str = r"\\thor\Equipment Files";

fn fixture() -> Engine {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "create table roots(root_id text primary key,path text,norm_path text,created_at text,last_crawl_at text,explorer_completed_at text,enabled integer);
         create table crawls(crawl_id text,root_id text,started_at text,completed_at text,status text,files_seen integer,dirs_seen integer,issues integer);
         create table files(file_id text primary key,path text,filename text,extension text,parent_path text,size_bytes integer,mtime_ns integer,observation_state text);",
    )
    .unwrap();
    c.execute("insert into roots values('r1',?1,?2,'2026-10-14','2026-10-14','2026-10-14',1)", [ROOT, &ROOT.to_lowercase()]).unwrap();
    c.execute("insert into crawls values('c1','r1','2026-10-14T19:00','2026-10-14T20:46','inventory_complete',30,20,0)", []).unwrap();
    let prefrac = r"2000 - CRUDE UNIT\10 - VESSELS\2010.03 (CS) V-3 PREFRACTIONATOR TOWER";
    let old = r"2000 - CRUDE UNIT\10 - VESSELS\OOS - 2010.03 (SS) PRE-FRACTIONATOR TOWER";
    let frac = r"2000 - CRUDE UNIT\10 - VESSELS\2010.04 V-4 FRACTIONATOR TOWER";
    let deeth = r"5600 - LRU\10 - VESSELS\5610.16 V-3 Deethanizer Column";
    let rows: Vec<(String, &str)> = vec![
        (format!(r"{prefrac}\DRAWINGS"), "PREFRAC TRAYS CA70300.pdf"),
        (format!(r"{prefrac}\REPAIRS\2007"), "2010.03-2007-Tray Ring Replacement Pkg.pdf"),
        (format!(r"{prefrac}\INSPECTIONS\2023-04-25 MN DRAW TRAY UT"), "UT DRAWING.pdf"),
        (format!(r"{prefrac}\INSPECTIONS\2023-04-25 MN DRAW TRAY UT"), "UT Cal Sheet.pdf"),
        (format!(r"{prefrac}\INSPECTIONS\2023-04-25 MN DRAW TRAY UT"), "UT Reader Sheet.pdf"),
        (format!(r"{prefrac}\INSPECTIONS\2023-12-18 EXT"), "2010.03 Inspection Report 12-18-23.pdf"),
        (format!(r"{prefrac}\DRAWINGS"), "2010.03 General Arrangement.pdf"),
        (format!(r"{old}\DRAWINGS"), "9050741-01 Tray Drawings 073119.pdf"),
        (format!(r"{old}\INSPECTIONS"), "2010.03 SS Inspection 2015.pdf"),
        (format!(r"{frac}\DRAWINGS"), "Crude Tower Tray Dwg CA80069-01.pdf"),
        (format!(r"{frac}\DRAWINGS"), "Crude Tower General Arrangement.pdf"),
        (format!(r"{frac}\INSPECTIONS\2025 UT"), "Crude Tower UT Survey 2025-01-16.pdf"),
        (format!(r"{deeth}\DRAWINGS"), "5610.16_V-3 DEETHANIZER COLUMN_INTERNAL TRAYS.pdf"),
        (format!(r"{deeth}\INSPECTIONS"), "5610.16 Inspection 2022.pdf"),
    ];
    for (i, (folder, name)) in rows.iter().enumerate() {
        let parent = format!(r"{ROOT}\{folder}\");
        let path = format!("{parent}{name}");
        let ext = name.rsplit_once('.').map(|x| format!(".{}", x.1.to_lowercase())).unwrap();
        c.execute("insert into files values(?1,?2,?3,?4,?5,1000,1700000000000000000,'current')", [&format!("f{i}"), &path, &name.to_string(), &ext, &parent]).unwrap();
    }
    Engine::new(Index::load_conn(&c).unwrap())
}

fn talk(e: &Engine, query: &str) -> SearchResponse {
    e.search(&SearchRequest { query: query.into(), limit: 100, ..Default::default() })
}

fn equipment_chips(r: &SearchResponse) -> Vec<String> {
    r.chips.iter().filter(|c| c.kind == "equipment").map(|c| c.text.clone()).collect()
}

#[test]
fn the_unit_picks_which_v3() {
    let e = fixture();
    let r = talk(&e, "crude unit v-3 trays");
    assert!(r.ambiguity.is_empty(), "nothing to ask: {:?}", r.ambiguity.iter().map(|a| &a.token).collect::<Vec<_>>());
    assert_eq!(equipment_chips(&r), vec!["2010.03"], "the in-service crude unit V-3");
    assert!(!r.hits.iter().any(|h| h.folder.contains("Deethanizer")), "not the LRU's V-3");
    assert!(!r.hits.iter().take(3).any(|h| h.folder.contains("OOS")), "not the retired one first");
}

#[test]
fn the_topic_beats_the_folder() {
    let e = fixture();
    let r = talk(&e, "crude unit v-3 trays");
    // Documents about trays come before files that only sit in a tray folder.
    let pos = |n: &str| r.hits.iter().position(|h| h.name == n).unwrap_or(usize::MAX);
    assert!(pos("PREFRAC TRAYS CA70300.pdf") < pos("UT Cal Sheet.pdf"), "{:?}", r.hits.iter().map(|h| &h.name).collect::<Vec<_>>());
    assert!(pos("2010.03-2007-Tray Ring Replacement Pkg.pdf") < pos("UT Reader Sheet.pdf"));
}

#[test]
fn shorthand_and_service_pick_the_prefrac() {
    let e = fixture();
    let r = talk(&e, "prefrac tray drawings");
    assert!(r.ambiguity.is_empty(), "in-service one is meant");
    assert_eq!(equipment_chips(&r), vec!["2010.03"]);
    assert_eq!(r.hits[0].name, "PREFRAC TRAYS CA70300.pdf");
}

#[test]
fn nicknames_from_file_names() {
    let e = fixture();
    // Files in 2010.04's folder call it "Crude Tower".
    let r = talk(&e, "crude tower ut");
    assert_eq!(equipment_chips(&r), vec!["2010.04"], "{:?}", r.chips.iter().map(|c| format!("{}:{}", c.kind, c.text)).collect::<Vec<_>>());
    assert_eq!(r.hits[0].name, "Crude Tower UT Survey 2025-01-16.pdf");
}

#[test]
fn a_clear_top_group() {
    let e = fixture();
    let r = talk(&e, "crude unit v-3 trays");
    assert!(r.top >= 1 && r.top <= 10 && r.top <= r.hits.len());
    assert_eq!(Engine::top_group(&[400.0, 395.0, 390.0, 200.0, 190.0]), 3);
    assert_eq!(Engine::top_group(&[100.0; 25]), 10, "never more than ten");
    assert_eq!(Engine::top_group(&[300.0, 100.0]), 2, "at least three, or all there are");
}
