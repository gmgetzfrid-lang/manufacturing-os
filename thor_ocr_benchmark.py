#!/usr/bin/env python3
"""THOR offline OCR benchmark v1.0. Standalone, no NAS access, no paid AI.
Requires: PyMuPDF (fitz), Tesseract executable; psutil recommended for child RAM watch.
Usage: python thor_ocr_benchmark.py --pdf-dir D:/THOR-Indexer/ocr_samples --out-dir D:/THOR-Indexer/ocr_benchmark
"""
import argparse, ctypes, datetime, json, os, pathlib, shutil, subprocess, sys, time

MAX_DOCS, MAX_PAGES, DPI, MAX_PDF_MB = 3, 3, 120, 40
OCR_TIMEOUT = 35
RAM_CAP_MB = 512


def local_directory(raw, *, must_exist):
    if raw.startswith(('\\\\', '//')): raise ValueError('UNC/network paths are forbidden for this benchmark')
    p = pathlib.Path(raw)
    if not p.is_absolute() or str(p.drive).upper()[:1] != 'D':
        raise ValueError('Only absolute local D: paths are permitted')
    for part in (p, *p.parents):
        if part.exists():
            st = part.lstat()
            if part.is_symlink() or (getattr(st, 'st_file_attributes', 0) & 0x400):
                raise ValueError('Symbolic links and Windows reparse-point paths are forbidden: ' + str(part))
    p = p.resolve(strict=False)
    if os.name == 'nt':
        drive_type = ctypes.windll.kernel32.GetDriveTypeW(str(p.drive) + '\\')
        if drive_type != 3: raise ValueError('Path must be on a local fixed disk; Windows drive type=' + str(drive_type))
    if must_exist and not p.is_dir(): raise ValueError('Directory does not exist: ' + str(p))
    return p


def tesseract_executable():
    options = [shutil.which('tesseract'), r'C:\Program Files\Tesseract-OCR\tesseract.exe',
               r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe']
    for c in options:
        if c and pathlib.Path(c).is_file(): return str(c)
    return None


def run_tesseract(exe, image_path, timeout, *, max_mem_mb):
    args = [exe, str(image_path), 'stdout', '-l', 'eng', '--psm', '3']
    env = dict(os.environ, OMP_THREAD_LIMIT='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
    txt = image_path.with_suffix('.ocr.txt')
    with txt.open('wb') as out:
        p = subprocess.Popen(args, stdout=out, stderr=subprocess.DEVNULL, env=env,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        peak = None
        try:
            import psutil
            proc = psutil.Process(p.pid)
            started = time.monotonic()
            while p.poll() is None:
                try:
                    rss = proc.memory_info().rss
                    peak = max(peak or 0, rss)
                    if rss > max_mem_mb * 1024 * 1024:
                        p.kill(); p.wait()
                        return {'status':'memory_limit', 'peak_child_ram_mb':round(peak/1048576,1)}
                except psutil.Error:
                    pass
                if time.monotonic() - started > timeout:
                    p.kill(); p.wait()
                    return {'status':'timeout', 'peak_child_ram_mb': round(peak/1048576,1) if peak else None}
                time.sleep(0.10)
            p.wait(timeout=3)
            out.flush()
            chars = len(txt.read_text(encoding='utf-8',errors='replace').strip())
            return {'status': 'ok' if p.returncode == 0 else 'ocr_error',
                    'characters':chars, 'peak_child_ram_mb':round(peak/1048576,1) if peak else None}
        finally:
            if p.poll() is None:
                p.kill();p.wait()
            try:txt.unlink(missing_ok=True)
            except OSError:pass


def main():
    ap=argparse.ArgumentParser(description='Offline, bounded OCR benchmark on local D: PDF copies')
    ap.add_argument('--pdf-dir',required=True,help='Folder with manually copied PDF samples, local D: only')
    ap.add_argument('--out-dir',required=True,help='Report and temporary PNG folder, local D: only')
    args=ap.parse_args()
    try:
        src=local_directory(args.pdf_dir,must_exist=True)
        dst=local_directory(args.out_dir,must_exist=False)
        if src == dst or src in dst.parents or dst in src.parents:
            raise ValueError('Input and output directories must be separate and non-nested')
        import fitz
        tess=tesseract_executable()
        if not tess:
            raise RuntimeError('Tesseract OCR is not installed/found. Install Tesseract OCR on Windows before running; no files were processed.')
        if not shutil.which('tesseract') and not pathlib.Path(tess).is_file():
            raise RuntimeError('Tesseract executable unavailable')
        try:
            import psutil
            have_psutil=True
        except ImportError:
            have_psutil=False
        if not have_psutil:
            raise RuntimeError('psutil is required to watch OCR child-process RAM. Install with: python -m pip install psutil')
        files=[]
        for path in sorted(src.iterdir()):
            if path.suffix.lower()!='.pdf' or not path.is_file():continue
            st=path.lstat()
            if path.is_symlink() or (getattr(st,'st_file_attributes',0) & 0x400):continue
            if st.st_size > MAX_PDF_MB*1048576:continue
            files.append(path)
            if len(files)==MAX_DOCS:break
        if not files:raise RuntimeError('No eligible PDF files found (max 40 MB/file). Put 1-3 local PDF copies in ' + str(src))
        dst.mkdir(parents=True,exist_ok=True)
        report={'tool':'THOR local OCR benchmark v1.0','created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'scope':'Local D: PDFs only; no NAS; no AI; no network operations',
                'limits':{'pdfs':MAX_DOCS,'pages_per_pdf':MAX_PAGES,'dpi':DPI,'max_pdf_mb':MAX_PDF_MB,
                          'ocr_timeout_seconds_per_page':OCR_TIMEOUT,'ocr_child_ram_limit_mb':RAM_CAP_MB,
                          'workers':1},'dependencies':{'pymupdf':fitz.VersionBind,'tesseract':tess,'psutil':have_psutil},'documents':[]}
        began=time.monotonic()
        for ix,path in enumerate(files,1):
            print(f'[{ix}/{len(files)}] {path.name}',flush=True)
            item={'filename':path.name,'file_bytes':path.stat().st_size,'pages':[]}
            report['documents'].append(item)
            try:
                with fitz.open(path) as doc:
                    item['total_pdf_pages']=len(doc)
                    for page_idx in range(min(MAX_PAGES,len(doc))):
                        page=doc[page_idx]
                        ts=time.monotonic()
                        native=page.get_text('text')
                        native_s=time.monotonic()-ts
                        result={'page':page_idx+1,'native_characters':len(native.strip()),
                                'native_seconds':round(native_s,3)}
                        if len(native.strip()) >= 60:
                            result['status']='native_text_sufficient'
                            print(f'   page {page_idx+1}: native text ({len(native.strip())} chars)',flush=True)
                        else:
                            img=dst / f'_temp_{ix}_{page_idx+1}.png'
                            started=time.monotonic()
                            try:
                                if (page.rect.width*DPI/72)*(page.rect.height*DPI/72)>9_000_000:raise RuntimeError('raster exceeds pixel safety limit')
                                pix=page.get_pixmap(matrix=fitz.Matrix(DPI/72,DPI/72),alpha=False,colorspace=fitz.csGRAY)
                                pix.save(str(img));del pix
                                ocr=run_tesseract(tess,img,OCR_TIMEOUT,max_mem_mb=RAM_CAP_MB)
                                result.update(ocr)
                                result['ocr_seconds']=round(time.monotonic()-started,3)
                                print(f"   page {page_idx+1}: OCR {ocr['status']} ({result['ocr_seconds']}s)",flush=True)
                            except Exception as e:
                                result['status']='page_error';result['error']=str(e)[:250]
                            finally:
                                try:img.unlink(missing_ok=True)
                                except OSError:pass
                        item['pages'].append(result)
            except Exception as e:item['error']=type(e).__name__+': '+str(e)[:300]
        report['total_seconds']=round(time.monotonic()-began,2)
        report['page_counts']={'native':sum(p.get('status')=='native_text_sufficient' for d in report['documents'] for p in d['pages']),
                               'ocr_ok':sum(p.get('status')=='ok' for d in report['documents'] for p in d['pages']),
                               'errors':sum(p.get('status') in ('page_error','ocr_error','timeout','memory_limit') for d in report['documents'] for p in d['pages'])}
        output=dst/'thor_ocr_benchmark_report.json'
        output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
        print('\nREPORT:',output,'\nSUMMARY:',report['page_counts'],'\nTOTAL SECONDS:',report['total_seconds'])
    except (ValueError,RuntimeError,ImportError) as e:
        print('BENCHMARK STOP:',str(e),file=sys.stderr);sys.exit(2)

if __name__=='__main__':main()
