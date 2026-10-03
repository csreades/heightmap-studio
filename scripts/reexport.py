"""Re-export stored setups by code, headless — no browser-driving needed.

Loads each export record via /?restore=<code>, reuses the ORIGINAL code
(mark, filename and /b/ link stay unchanged) and saves the regenerated
3MF/STL into exports/files/ where the server serves them at
/exports_files/. Writes an index.html link list there too.

Usage:
  .venv/bin/python scripts/reexport.py CODE [CODE ...]
  .venv/bin/python scripts/reexport.py --all          # every record on disk
  .venv/bin/python scripts/reexport.py --format stl CODE ...
  .venv/bin/python scripts/reexport.py --sweep CODE   # support sweep of that design

CODE is a 6-character base code or a legacy 12-hex guid.
--sweep runs the Support sweep on each stored design instead: 19 test bases
with fresh records of their own, saved as <design code>_support_sweep_*.
"""
import argparse
import glob
from html import escape as _esc
import json
import os
import sys
import time
from urllib.parse import quote

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports", "files")
BASE_URL = os.environ.get("HMS_URL", "http://127.0.0.1:8000")


def reexport(pg, guid: str, fmt: str, sweep: bool = False) -> list[str]:
    pg.goto(f"{BASE_URL}/?restore={quote(guid)}", timeout=60000)
    pg.wait_for_load_state("networkidle", timeout=120000)
    pg.wait_for_timeout(1500)
    if not sweep:   # a sweep mints its own records; plain re-exports keep the code
        pg.evaluate("g => { window.__reuse_guid = g; }", guid)
    pg.get_by_text("Bases", exact=False).first.click()
    # wait for the preview fetch so state is fully wired
    pg.wait_for_function("() => lastBases !== null", timeout=180000)

    saved = []
    done = []
    pg.on("download", lambda d: done.append(d))
    if sweep:
        label, expect = "Support sweep", 2            # 3MF + legend
    else:
        label = "Export 3MF" if fmt == "3mf" else "Export STL"
        # STL also drops a params.json sidecar
        expect = 1 if fmt == "3mf" else 2
    pg.get_by_text(label, exact=True).click()
    t0 = time.time()
    while len(done) < expect and time.time() - t0 < 600:
        pg.wait_for_timeout(500)
        # the export button re-enables when the work is finished
    pg.wait_for_timeout(1500)
    for d in done:
        name = f"{guid}_{d.suggested_filename}" if sweep else d.suggested_filename
        d.save_as(os.path.join(OUT, name))
        saved.append(name)
    return saved


def write_index():
    rows = []
    for p in sorted(glob.glob(os.path.join(OUT, "*")),
                    key=os.path.getmtime, reverse=True):
        name = os.path.basename(p)
        if name == "index.html":
            continue
        mb = os.path.getsize(p) / 1e6
        name = _esc(name, quote=True)
        rows.append(f'<li><a href="/exports_files/{name}" download>{name}</a>'
                    f' <small>({mb:.0f} MB)</small></li>')
    html = ("<!doctype html><meta charset=utf-8><title>re-exports</title>"
            "<style>body{font-family:system-ui;background:#181c22;color:#dde;"
            "max-width:560px;margin:40px auto}a{color:#7fb3ff}</style>"
            f"<h2>Re-exported files</h2><ul>{''.join(rows)}</ul>")
    with open(os.path.join(OUT, "index.html"), "w") as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("guids", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--format", choices=["3mf", "stl"], default="3mf")
    ap.add_argument("--sweep", action="store_true",
                    help="run the Support sweep on each design instead of re-exporting it")
    args = ap.parse_args()

    guids = args.guids
    if args.all:
        guids = sorted(os.path.splitext(os.path.basename(p))[0]
                       for p in glob.glob(os.path.join(ROOT, "exports", "*.json")))
    if not guids:
        ap.error("no guids given (or use --all)")
    os.makedirs(OUT, exist_ok=True)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/chromium",
                              args=["--no-sandbox", "--disable-gpu"])
        ok, fail = [], []
        for i, guid in enumerate(guids, 1):
            ctx = b.new_context(accept_downloads=True)
            pg = ctx.new_page()
            pg.on("dialog", lambda d: d.accept())
            try:
                t0 = time.time()
                files = reexport(pg, guid, args.format, args.sweep)
                if files:
                    print(f"[{i}/{len(guids)}] {guid}: {', '.join(files)} "
                          f"({time.time()-t0:.0f}s)")
                    ok.append(guid)
                else:
                    print(f"[{i}/{len(guids)}] {guid}: NO DOWNLOAD")
                    fail.append(guid)
            except Exception as e:
                print(f"[{i}/{len(guids)}] {guid}: FAILED — {e}")
                fail.append(guid)
            finally:
                ctx.close()
        b.close()
    write_index()
    print(f"\ndone: {len(ok)} ok, {len(fail)} failed"
          + (f" ({', '.join(fail)})" if fail else ""))
    print(f"browse: {BASE_URL}/exports_files/")


if __name__ == "__main__":
    main()
