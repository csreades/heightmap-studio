"""Re-export stored setups by guid, headless — no browser-driving needed.

Loads each export record via /?restore=<guid>, reuses the ORIGINAL guid
(QR, filename and /b/ link stay unchanged) and saves the regenerated
3MF/STL into exports/files/ where the server serves them at
/exports_files/. Writes an index.html link list there too.

Usage:
  .venv/bin/python scripts/reexport.py GUID [GUID ...]
  .venv/bin/python scripts/reexport.py --all          # every record on disk
  .venv/bin/python scripts/reexport.py --format stl GUID ...
"""
import argparse
import glob
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports", "files")
BASE_URL = os.environ.get("HMS_URL", "http://127.0.0.1:8000")


def reexport(pg, guid: str, fmt: str) -> list[str]:
    pg.goto(f"{BASE_URL}/?restore={guid}", timeout=60000)
    pg.wait_for_load_state("networkidle", timeout=120000)
    pg.wait_for_timeout(1500)
    pg.evaluate(f"window.__reuse_guid = '{guid}'")
    pg.get_by_text("Bases", exact=False).first.click()
    # wait for the preview fetch so state is fully wired
    pg.wait_for_function("() => lastBases !== null", timeout=180000)

    saved = []
    done = []
    pg.on("download", lambda d: done.append(d))
    label = "Export 3MF" if fmt == "3mf" else "Export STL"
    pg.get_by_text(label, exact=True).click()
    # STL also drops a params.json sidecar; wait until downloads settle
    expect = 1 if fmt == "3mf" else 2
    t0 = time.time()
    while len(done) < expect and time.time() - t0 < 600:
        pg.wait_for_timeout(500)
        # the export button re-enables when the work is finished
    pg.wait_for_timeout(1500)
    for d in done:
        path = os.path.join(OUT, d.suggested_filename)
        d.save_as(path)
        saved.append(d.suggested_filename)
    return saved


def write_index():
    rows = []
    for p in sorted(glob.glob(os.path.join(OUT, "*")),
                    key=os.path.getmtime, reverse=True):
        name = os.path.basename(p)
        if name == "index.html":
            continue
        mb = os.path.getsize(p) / 1e6
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
                files = reexport(pg, guid, args.format)
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
