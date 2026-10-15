//! TracePoint 1.0.11 ranking checks (Test-RankingUpdate), ported. The new
//! engine must keep every behaviour the original was validated on.

use rusqlite::Connection;
use tp_core::engine::{Engine, SearchRequest};
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
    c.execute(
        "insert into roots values('r1',?1,?2,'2026-10-14','2026-10-14','2026-10-14',1)",
        [ROOT, &ROOT.to_lowercase()],
    )
    .unwrap();
    c.execute("insert into crawls values('c1','r1','2026-10-14T19:00','2026-10-14T20:46','inventory_complete',14,9,0)", []).unwrap();
    let v2 = r"5600 - LRU\10 - VESSELS\5610.15 V-2 Suction Bottle";
    let mut rows: Vec<(String, String)> = vec![
        (format!(r"{v2}\INSPECTIONS\2023 EXT"), "BLANK BOTTLE INSPECTION DRAWING.pdf".into()),
        (format!(r"{v2}\INSPECTIONS\2023 EXT"), "Field Notes.pdf".into()),
        (format!(r"{v2}\INSPECTIONS\2023 EXT"), "API Visual Checklist.pdf".into()),
        (format!(r"{v2}\INSPECTIONS\2023 EXT"), "Bottle EXT INSPECTION REPORT.pdf".into()),
        (r"5600 - LRU\17 - PRESSURE RELIEF DEVICES\5617.07 PSV-110 Discharge Bottle Relief\INSPECTIONS\2023 EXT".into(), "PSV Bottle Inspection Checklist.pdf".into()),
        (r"5500 - TRANSMIX\10 - VESSELS\Archive\5510.06 V-2 SPLITTER DRUM (Now 5610.15)\INSPECTIONS\2012 EXT".into(), "5510.06 Inspection Report.pdf".into()),
        (r"7200 - STORAGE\10 - VESSELS\5610.20 Tank\Drawings".into(), "TK-1100 Drawing.pdf".into()),
    ];
    for n in 1..=5 {
        rows.push((format!(r"{v2}\INSPECTIONS\2023 EXT\Photos"), format!("5610.15_photo{n}.jpg")));
    }
    for (i, (folder, name)) in rows.iter().enumerate() {
        let parent = format!(r"{ROOT}\{folder}\");
        let path = format!("{parent}{name}");
        let ext = name.rsplit_once('.').map(|x| format!(".{}", x.1.to_lowercase())).unwrap();
        c.execute(
            "insert into files values(?1,?2,?3,?4,?5,1000,1700000000000000000,'current')",
            [&format!("f{i}"), &path, name, &ext, &parent],
        )
        .unwrap();
    }
    Engine::new(Index::load_conn(&c).unwrap())
}

fn q(e: &Engine, query: &str) -> tp_core::engine::SearchResponse {
    // TracePoint 1.x semantics: exact mode.
    e.search(&SearchRequest { query: query.into(), limit: 100, mode: "exact".into(), ..Default::default() })
}

fn talk(e: &Engine, query: &str) -> tp_core::engine::SearchResponse {
    e.search(&SearchRequest { query: query.into(), limit: 100, ..Default::default() })
}

#[test]
fn natural_language_requests() {
    let e = fixture();
    let r = talk(&e, "I need the external inspection report for the suction bottle");
    assert_eq!(r.mode, "natural");
    assert!(r.total > 0, "{:?}", r.notice);
    assert_eq!(r.hits[0].name, "Bottle EXT INSPECTION REPORT.pdf", "{:?}", r.hits.iter().map(|h| (&h.name, h.score)).collect::<Vec<_>>());
    let r = talk(&e, "can you find pictures of that suction bottle in the LRU");
    assert!(r.hits.iter().take(5).all(|h| h.category == "Photos"), "{:?}", r.hits.iter().map(|h| &h.name).collect::<Vec<_>>());
    let r = talk(&e, "where are the field notes from when they checked the suction bottle in 2023");
    assert_eq!(r.hits[0].name, "Field Notes.pdf");
    // Auto mode falls back to best fit when an exact search finds nothing.
    let r = talk(&e, "suction bottle checklist");
    assert!(r.total > 0 && r.hits[0].name.to_lowercase().contains("checklist"), "{:?}", r.hits.iter().map(|h| &h.name).collect::<Vec<_>>());
}

#[test]
fn inspection_record_leads_blank_template() {
    let e = fixture();
    let r = q(&e, "bottle inspection");
    assert_eq!(r.hits[0].category, "Inspection / MI");
    assert!(!r.hits[0].blank, "first hit must not be the blank template: {}", r.hits[0].name);
}

#[test]
fn field_notes_ahead_of_photos_and_two_photos_per_folder() {
    let e = fixture();
    let r = q(&e, "bottle inspection");
    let notes = r.hits.iter().find(|h| h.name == "Field Notes.pdf").expect("field notes");
    let photos: Vec<_> = r.hits.iter().filter(|h| h.category == "Photos").collect();
    assert_eq!(photos.len(), 2, "two supporting photos per folder");
    assert!(photos.iter().all(|p| notes.score > p.score));
    assert_eq!(r.suppressed_photos, 3);
}

#[test]
fn explicit_photo_request_expands_group() {
    let e = fixture();
    let r = q(&e, "5610.15 photos");
    assert_eq!(r.hits.iter().filter(|h| h.category == "Photos").count(), 5);
}

#[test]
fn include_photos_setting_preserves_all_photos() {
    let e = fixture();
    let r = e.search(&SearchRequest { query: "bottle inspection".into(), limit: 100, include_photos: true, mode: "exact".into(), ..Default::default() });
    assert_eq!(r.hits.iter().filter(|h| h.category == "Photos").count(), 5);
}

#[test]
fn partial_equipment_number_rejected() {
    let e = fixture();
    assert_eq!(q(&e, "5610.150 inspection").total, 0);
}

#[test]
fn historical_equipment_mapping_retained() {
    let e = fixture();
    let r = q(&e, "5510.06 inspection");
    assert!(r.total > 0);
    assert_eq!(r.card.as_ref().map(|c| c.number.as_str()), Some("5610.15"));
    assert!(r.hits.iter().any(|h| h.equipment.iter().any(|x| x.number == "5610.15")));
}

#[test]
fn alias_and_year_bounds() {
    let e = fixture();
    let r = e.search(&SearchRequest { query: "V02 inspection".into(), limit: 20, year_min: Some(2023), mode: "exact".into(), ..Default::default() });
    assert!(r.total > 0);
    assert_eq!(r.hits[0].equipment[0].number, "5610.15");
    let r = e.search(&SearchRequest { query: "V02 inspection".into(), limit: 20, year_min: Some(2024), mode: "exact".into(), ..Default::default() });
    assert_eq!(r.total, 0, "year bound excludes earlier records");
}

#[test]
fn explicit_blank_request_prioritizes_template() {
    let e = fixture();
    let r = q(&e, "bottle blank");
    assert!(r.hits[0].name.contains("BLANK"));
}

#[test]
fn all_terms_required() {
    let e = fixture();
    let r = q(&e, "bottle inspection");
    assert!(r.hits.iter().all(|h| !h.folder.contains("5610.16")));
    assert_eq!(q(&e, "bottle missingword").total, 0, "missing topic returns nothing");
}

#[test]
fn uncatalogued_tag_formatting() {
    let e = fixture();
    assert_eq!(q(&e, "TK1100 drawing").total, 1);
    assert_eq!(q(&e, "TK1100 inspection").total, 0, "literal tag still requires the topic");
}

#[test]
fn typo_tolerance_and_reasons() {
    let e = fixture();
    let r = q(&e, "botle inspection");
    assert!(r.total > 0, "one-letter typo in a 5+ letter word is forgiven");
    assert!(r.chips.iter().any(|c| c.kind == "fuzzy"));
    assert!(r.hits.iter().all(|h| !h.reasons.is_empty()));
}

#[test]
fn ambiguous_tag_asks_which() {
    let e = fixture();
    let r = q(&e, "V-2");
    assert_eq!(r.ambiguity.len(), 1, "V-2 is 5610.15 in LRU and 5510.06 in TRANSMIX");
    let pinned = e.search(&SearchRequest { query: "V-2".into(), limit: 50, equipment: Some(r.ambiguity[0].options[0].id), mode: "exact".into(), ..Default::default() });
    assert!(pinned.ambiguity.is_empty());
    assert!(pinned.card.is_some());
}
