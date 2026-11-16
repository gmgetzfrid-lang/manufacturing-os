#!/usr/bin/env python3
"""End-to-end test for Scan Intake without Windows or a real API key.

Builds a fake network drive and scan drive, drops scanned-looking PDFs in,
runs the intake-dev server against a local stand-in for the Messages API,
and checks what lands on the drive: folders, file names, page splits, PDF
properties, text layer, duplicates, review, and the Excel indexes.

    INTAKE_PDFIUM=/path/libpdfium.so python3 intake/tests/e2e.py target/debug/intake-dev
"""
import io, json, os, shutil, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
import openpyxl

BIN = sys.argv[1]
T = os.path.abspath(os.environ.get("E2E_DIR", "/tmp/intake-e2e"))
shutil.rmtree(T, ignore_errors=True)
NET = os.path.join(T, "net")
ROOT = os.path.join(T, "E", "Digital Project")
LOCAL = os.path.join(T, "local")
for d in [
    "2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER/DATA SHEETS",
    "2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER/CODE DOCUMENTS",
    "2000 - CRUDE UNIT/10 - VESSELS/O - OOS - 2010.03 (SS) PRE-FRACTIONATOR TOWER",
    "2000 - CRUDE UNIT/26 - PUMPS (CENTRIFUGAL)/2026.14 P-14 CRUDE CHARGE PUMP",
]:
    os.makedirs(os.path.join(NET, d), exist_ok=True)
# A file already on the network with the name the first U-1A will get.
open(os.path.join(NET, "2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER/CODE DOCUMENTS/2010.03 U-1A Manufacturer's Data Report 1978-03-14.pdf"), "wb").write(b"%PDF-1.4\n")
os.makedirs(ROOT, exist_ok=True)
os.makedirs(LOCAL, exist_ok=True)
json.dump({"root": ROOT, "references": [NET], "model": "claude-opus-5-5", "author": "Kern Energy", "parallel": 2,
           "key_sealed": "c2stYW50LXRlc3Qta2V5LTEyMzQ1Njc4OTA=", "paused": False}, open(os.path.join(LOCAL, "settings.json"), "w"))


def scan_pdf(path, pages, producer="Canon iR-ADV C5535 PDF"):
    """Image-only pages (like a scanner makes). pages: list of (label, w_in, h_in, blank)."""
    w = PdfWriter()
    for label, wi, hi, blank in pages:
        img = Image.new("RGB", (int(wi * 100), int(hi * 100)), "white")
        if not blank:
            dr = ImageDraw.Draw(img)
            for k in range(12):
                dr.text((60, 60 + k * 40), f"{label} line {k} " + "x" * 40, fill="black")
            dr.rectangle([40, 40, img.width - 40, img.height - 40], outline="black", width=3)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(wi * 72, hi * 72))
        ib = io.BytesIO()
        img.save(ib, "JPEG")
        ib.seek(0)
        from reportlab.lib.utils import ImageReader
        c.drawImage(ImageReader(ib), 0, 0, wi * 72, hi * 72)
        c.showPage()
        c.save()
        w.add_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])
    w.add_metadata({"/Producer": producer, "/Creator": "Canon", "/Author": "scanner01"})
    out = io.BytesIO()
    w.write(out)
    open(path, "wb").write(out.getvalue())


# ---- Stand-in Messages API -------------------------------------------------
REQUESTS = []

FILINGS = {
    "2010.03.pdf": {
        "equipment": {"number": "2010.03", "tag": "V-3", "description": "PREFRACTIONATOR TOWER", "existing_folder": "2010.03 (CS) V-3 PREFRACTIONATOR TOWER", "confidence": "high", "evidence": "U-1A page 1", "matches_file_name": "yes"},
        "documents": [
            {"first_page": 1, "last_page": 3, "continues_previous_part": False, "folder": "CODE DOCUMENTS", "title": "U-1A Manufacturer's Data Report", "date": "1978-03-14", "date_basis": "signed", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "ASME U-1A for the prefractionator tower.", "drop_pages": [3], "confidence": "high", "verdict": "confirmed", "doubts": ""},
            {"first_page": 4, "last_page": 5, "continues_previous_part": False, "folder": "DRAWINGS", "title": "Drawing 2010-D 1041 Shell Layout", "date": "1975-02", "date_basis": "rev", "written_for_number": "2010.15", "written_for_tag": "V-15", "relation": "former_identity", "drawing_number": "2010-D 1041", "revision": "2", "summary": "Shell layout drawn when the vessel was V-15.", "drop_pages": [], "confidence": "high", "verdict": "confirmed", "doubts": ""},
            {"first_page": 6, "last_page": 6, "continues_previous_part": False, "folder": "DATASHEETS", "title": "Tray Data Sheet / Nozzle List", "date": "", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "Tray data.", "drop_pages": [], "confidence": "high", "verdict": "corrected", "doubts": ""},
        ],
        "notes": "",
    },
    "doc0000123456789.pdf": {
        "equipment": {"number": "2530.01", "tag": "E-1", "description": "Feed / Effluent Exchanger", "existing_folder": "", "confidence": "high", "evidence": "TEMA sheet", "matches_file_name": "no_file_name"},
        "documents": [
            {"first_page": 1, "last_page": 2, "continues_previous_part": False, "folder": "DATASHEETS", "title": "TEMA Exchanger Specification Sheet", "date": "1991-06-03", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "TEMA sheet.", "drop_pages": [], "confidence": "high", "verdict": "confirmed", "doubts": ""},
            {"first_page": 3, "last_page": 3, "continues_previous_part": False, "folder": "VENDOR DATA", "title": "Purchase Order 4471 - Southwest Heat Transfer", "date": "1991-04-20", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "PO.", "drop_pages": [], "confidence": "high", "verdict": "confirmed", "doubts": ""},
        ],
        "notes": "",
    },
    "2010.04.pdf": {
        "equipment": {"number": "2010.04", "tag": "V-4", "description": "FRACTIONATOR TOWER", "existing_folder": "", "confidence": "high", "evidence": "", "matches_file_name": "yes"},
        "documents": [
            {"first_page": 1, "last_page": 1, "continues_previous_part": False, "folder": "INSPECTIONS", "title": "UT Thickness Survey", "date": "1999-10-21", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "", "drop_pages": [], "confidence": "high", "verdict": "confirmed", "doubts": ""},
        ],
        "notes": "",
    },
    "2026.14.pdf": {
        "equipment": {"number": "2026.14", "tag": "P-14", "description": "CRUDE CHARGE PUMP", "existing_folder": "", "confidence": "high", "evidence": "", "matches_file_name": "yes"},
        "documents": [
            {"first_page": 1, "last_page": 1, "continues_previous_part": False, "folder": "VENDOR DATA", "title": "Pump Curve", "date": "1988", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "same_equipment", "drawing_number": "", "revision": "", "summary": "", "drop_pages": [], "confidence": "high", "verdict": "confirmed", "doubts": ""},
            {"first_page": 2, "last_page": 2, "continues_previous_part": False, "folder": "CORRESPONDENCE", "title": "Handwritten Note", "date": "", "date_basis": "", "written_for_number": "", "written_for_tag": "", "relation": "unidentified", "drawing_number": "", "revision": "", "summary": "", "drop_pages": [], "confidence": "low", "verdict": "uncertain", "doubts": "Mostly illegible; may belong with the pump curve."},
        ],
        "notes": "",
    },
}


OVERLOAD_ONCE = {"2010.04.pdf"}


class Api(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n))
        content = req["messages"][0]["content"]
        ctx = content[0]["text"]
        name = ctx.split("Scan file name: ")[1].split("\n")[0]
        check = "FIRST READING" in content[-1]["text"]
        images = sum(1 for c in content if c.get("type") == "image")
        cache_points = sum(1 for c in content if "cache_control" in c) + 1
        REQUESTS.append({"name": name, "check": check, "images": images, "cache_points": cache_points,
                         "schema": req["output_config"]["format"]["type"], "model": req["model"],
                         "beta": self.headers.get("anthropic-beta"), "key": self.headers.get("x-api-key"),
                         "effort": req["output_config"]["effort"], "stream": req["stream"]})
        if name in OVERLOAD_ONCE:
            OVERLOAD_ONCE.discard(name)
            body = json.dumps({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}).encode()
            self.send_response(529)
            self.send_header("content-type", "application/json")
            self.send_header("retry-after", "1")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        filing = FILINGS[name]
        if not check:
            filing = json.loads(json.dumps(filing))
            for d in filing["documents"]:
                d["verdict"] = "first_look"
        text = json.dumps(filing)
        events = [
            {"type": "message_start", "message": {"model": req["model"], "usage": {"input_tokens": 1000, "cache_read_input_tokens": 5000 if check else 0, "cache_creation_input_tokens": 0 if check else 5000}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
            {"type": "content_block_start", "index": 1, "content_block": {"type": "text"}},
        ]
        for i in range(0, len(text), 200):
            events.append({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": text[i:i + 200]}})
        events.append({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 800}})
        events.append({"type": "message_stop"})
        body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


api = ThreadingHTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=api.serve_forever, daemon=True).start()
api_base = f"http://127.0.0.1:{api.server_address[1]}"

# ---- Run ------------------------------------------------------------------
PORT = "7981"
env = dict(os.environ, INTAKE_API_BASE=api_base, INTAKE_FAKE_OCR="1")
srv = subprocess.Popen([BIN, PORT, LOCAL], env=env, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)


def call(cmd, args=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/{cmd}", data=json.dumps(args or {}).encode(), headers={"content-type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        return {"__error": e.code, **json.loads(e.read() or b"{}")}


ok = True


def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg)
    ok = ok and cond


try:
    for _ in range(50):
        try:
            call("state")
            break
        except Exception:
            time.sleep(0.2)
    # Drop the scans in (like the scanner would).
    scan_pdf(os.path.join(ROOT, "2010.03.pdf"), [("U-1A p1", 8.5, 11, False), ("U-1A p2", 8.5, 11, False), ("", 8.5, 11, True), ("DRAWING", 36, 24, False), ("DRAWING sht2", 36, 24, False), ("TRAY DATA", 8.5, 11, False)])
    scan_pdf(os.path.join(ROOT, "doc0000123456789.pdf"), [("TEMA 1", 8.5, 11, False), ("TEMA 2", 8.5, 11, False), ("PO", 8.5, 11, False)])
    scan_pdf(os.path.join(ROOT, "2026.14.pdf"), [("CURVE", 11, 8.5, False), ("NOTE", 8.5, 11, False)])
    shutil.copy(os.path.join(ROOT, "2010.03.pdf"), os.path.join(T, "copy.pdf"))
    deadline = time.time() + 120
    while time.time() < deadline:
        st = call("state")
        by = st.get("counts", {}).get("by_status", {})
        if by.get("filed", 0) == 2 and by.get("review", 0) == 1:
            break
        time.sleep(1)
    # Same file dropped again later: recognised as a duplicate.
    shutil.copy(os.path.join(T, "copy.pdf"), os.path.join(ROOT, "2010.03 (2).pdf"))
    for _ in range(60):
        by = call("state").get("counts", {}).get("by_status", {})
        if by.get("duplicate", 0) == 1:
            break
        time.sleep(1)
    st = call("state")
    by = st["counts"]["by_status"]
    print(json.dumps(st["counts"]))
    check(by.get("filed") == 2, "two scans filed")
    check(by.get("review") == 1, "uncertain scan held for review")
    check(by.get("duplicate") == 1, "identical re-drop recognised as duplicate")
    check(not [f for f in os.listdir(ROOT) if f.lower().endswith(".pdf")], "drop folder emptied")
    check(len(os.listdir(os.path.join(ROOT, "_ORIGINAL SCANS"))) == 1 and len(os.listdir(os.path.join(ROOT, "_ORIGINAL SCANS", os.listdir(os.path.join(ROOT, "_ORIGINAL SCANS"))[0]))) == 4, "originals kept")

    v3 = os.path.join(ROOT, "2000 - CRUDE UNIT", "10 - VESSELS", "2010.03 (CS) V-3 PREFRACTIONATOR TOWER")
    files = sorted(os.path.relpath(os.path.join(dp, f), v3) for dp, _, fs in os.walk(v3) for f in fs)
    print("\n".join(files))
    check("CODE DOCUMENTS/2010.03 U-1A Manufacturer's Data Report 1978-03-14 (2).pdf" in files, "U-1A named, avoids the name already on the network")
    check("DRAWINGS/2010.03 Drawing 2010-D 1041 Shell Layout (as 2010.15 V-15) 1975-02.pdf" in files, "history drawing named with former identity")
    check("DATA SHEETS/2010.03 Tray Data Sheet - Nozzle List Undated.pdf" in files, "existing 'DATA SHEETS' spelling reused, undated named")
    u1a = PdfReader(os.path.join(v3, "CODE DOCUMENTS/2010.03 U-1A Manufacturer's Data Report 1978-03-14 (2).pdf"))
    check(len(u1a.pages) == 2, f"blank back page dropped (pages={len(u1a.pages)})")
    meta = u1a.metadata
    print(dict(meta))
    check(meta.get("/Title") == "2010.03 U-1A Manufacturer's Data Report 1978-03-14 (2)", "title property is the file name")
    check(meta.get("/Author") == "Kern Energy" and meta.get("/Producer") == "Kern Energy" and meta.get("/Creator") == "Kern Energy", "properties say Kern Energy")
    raw = open(os.path.join(v3, "CODE DOCUMENTS/2010.03 U-1A Manufacturer's Data Report 1978-03-14 (2).pdf"), "rb").read()
    check(b"Canon" not in raw and b"scanner01" not in raw and b"Claude" not in raw and b"Anthropic" not in raw and b"pdfium" not in raw.lower() and b"lopdf" not in raw.lower(), "no scanner, tool or AI names inside the PDF")
    check("<x:xmpmeta" not in raw.decode("latin-1"), "no XMP metadata")
    txt = subprocess.run(["pdftotext", "-raw", os.path.join(v3, "CODE DOCUMENTS/2010.03 U-1A Manufacturer's Data Report 1978-03-14 (2).pdf"), "-"], capture_output=True, text=True).stdout
    check("SCANNED TEXT LAYER" in txt, "invisible OCR text layer is searchable")
    dr = PdfReader(os.path.join(v3, "DRAWINGS/2010.03 Drawing 2010-D 1041 Shell Layout (as 2010.15 V-15) 1975-02.pdf"))
    check(len(dr.pages) == 2 and float(dr.pages[0].mediabox.width) > 2000, "D-size drawing pages kept at full size")

    e1 = os.path.join(ROOT, "2500 - DIESEL HYDROTREATER UNIT (DHT)", "30 - EXCHANGERS", "2530.01 E-1 FEED - EFFLUENT EXCHANGER")
    check(os.path.isdir(e1), "new equipment folder created from the papers (unknown file name)")
    check(os.path.exists(os.path.join(e1, "VENDOR DATA", "2530.01 Purchase Order 4471 - Southwest Heat Transfer 1991-04-20.pdf")), "PO in VENDOR DATA")

    # Indexes.
    unit_idx = os.path.join(ROOT, "2000 - CRUDE UNIT", "2000 - CRUDE UNIT INDEX.xlsx")
    for _ in range(30):
        if os.path.exists(unit_idx) and os.path.exists(os.path.join(ROOT, "MASTER INDEX.xlsx")):
            break
        time.sleep(1)
    wb = openpyxl.load_workbook(unit_idx)
    ws = wb["Documents"]
    rows = list(ws.iter_rows(values_only=True))
    check(any(r[12] and "already in this folder on the network" in r[12] for r in rows[1:]), "network name clash noted in the index")
    check(rows[0][0] == "Equipment No." and len(rows) == 4, f"unit index lists the 3 crude documents ({len(rows) - 1})")
    link = ws.cell(row=2, column=11).hyperlink
    from urllib.parse import unquote
    target = unquote(link.target) if link else ""
    check(link is not None and not target.startswith("file:") and target.startswith("10 - VESSELS\\2010.03 (CS)"), f"relative link in unit index ({target})")
    check(os.path.exists(os.path.join(ROOT, "2000 - CRUDE UNIT", target.replace("\\", "/"))), "unit index link resolves to the filed PDF")
    check(wb.properties.creator == "Kern Energy", "index author Kern Energy")
    import zipfile
    z = zipfile.ZipFile(unit_idx)
    allxml = b"".join(z.read(n) for n in z.namelist())
    check(b"rust_xlsxwriter" not in allxml and b"Claude" not in allxml, "no tool names in the workbook")
    m = openpyxl.load_workbook(os.path.join(ROOT, "MASTER INDEX.xlsx"))["Documents"]
    check(m.max_row == 6, f"master index lists all 5 documents ({m.max_row - 1})")

    # Requests were well formed.
    check(all(r["schema"] == "json_schema" and r["stream"] and r["key"] == "sk-ant-test-key-1234567890" for r in REQUESTS), "structured, streamed, keyed requests")
    check(all(r["cache_points"] <= 4 for r in REQUESTS), "cache breakpoints within limit")
    check(sum(1 for r in REQUESTS if r["name"] == "2010.03.pdf") == 2, "two passes per scan")
    big = [r for r in REQUESTS if r["name"] == "2010.03.pdf"][0]
    check(big["images"] == 8, f"page images + title-block close-ups sent ({big['images']})")

    # Review: the person fixes the held scan.
    held = call("scans", {"status": "review"})[0]
    if os.environ.get("E2E_SHOTS"):
        subprocess.run(["node", os.environ["E2E_SHOTS"] + "/shoot.js", PORT, os.environ["E2E_SHOTS"], str(held["id"])], cwd=os.environ["E2E_SHOTS"], check=False)
    detail = call("scan", {"id": held["id"]})
    check(detail["flagged"] == [1], f"the uncertain document is flagged ({detail['flagged']})")
    check(any("Document 2 (page 2)" in p and "illegible" in p for p in held["problems"]), f"held reason names the document and the doubt ({held['problems']})")
    filed = {s["file_name"]: s for s in call("scans", {"status": "filed"})}
    check(filed["2010.03.pdf"]["new_folder"] is False and filed["doc0000123456789.pdf"]["new_folder"] is True, "'new folder' only for equipment not on the network")
    f = detail["filing"]
    f["documents"][1]["title"] = "Handwritten Note - Impeller Trim"
    f["documents"][1]["folder"] = "CORRESPONDENCE"
    r = call("review.file", {"id": held["id"], "filing": f})
    check(r.get("ok") is True, f"review filed ({r})")
    p14 = os.path.join(ROOT, "2000 - CRUDE UNIT", "26 - PUMPS (CENTRIFUGAL)", "2026.14 P-14 CRUDE CHARGE PUMP")
    check(os.path.exists(os.path.join(p14, "CORRESPONDENCE", "2026.14 Handwritten Note - Impeller Trim Undated.pdf")), "reviewed document filed into the existing network folder name")
    # Take back and refile works.
    r = call("scan.unfile", {"id": held["id"]})
    check(r.get("ok") is True and not os.path.exists(os.path.join(p14, "CORRESPONDENCE", "2026.14 Handwritten Note - Impeller Trim Undated.pdf")), "take back removes generated files")
    img = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/page/{held['id']}/1").read()
    check(img[:2] == b"\xff\xd8", "page images served for review")
    st = call("state")
    check(abs(st["counts"]["cost"] - (3 * 2 * (1000 * 4 + 800 * 20) / 1e6 + 3 * (5000 * 5 / 1e6) + 3 * (5000 * 0.2 / 1e6))) < 0.01, f"cost tracked (${st['counts']['cost']:.3f})")
    # The network folder goes away: nothing is filed until it is back.
    call("settings.save", {"references": [NET + "-offline"]})
    time.sleep(3)
    scan_pdf(os.path.join(ROOT, "2010.04.pdf"), [("UT", 8.5, 11, False)])
    time.sleep(14)
    st = call("state")
    q = [x for x in call("scans") if x["file_name"] == "2010.04.pdf"]
    check(q and q[0]["status"] == "queued" and "not reachable" in st["notice"], f"waits while the network folder is unreachable ({q[0]['status'] if q else None}; {st['notice']})")
    os.rename(NET, NET + "-offline")
    deadline = time.time() + 60
    while time.time() < deadline:
        q = [x for x in call("scans") if x["file_name"] == "2010.04.pdf"]
        if q and q[0]["status"] == "filed":
            break
        time.sleep(1)
    check(q and q[0]["status"] == "filed", f"continues when the network folder is back, after an overloaded reply ({q[0]['status'] if q else None} {q[0]['error'] if q else ''})")
    check(os.path.isdir(os.path.join(ROOT, "2000 - CRUDE UNIT", "10 - VESSELS", "2010.04 V-4 FRACTIONATOR TOWER", "INSPECTIONS")), "filed after recovery")
finally:
    srv.terminate()
    try:
        err = srv.stderr.read().decode(errors="replace")
        if not ok:
            print(err[-3000:])
    except Exception:
        pass
    api.shutdown()

print("ALL PASSED" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
