"""FastAPI tile server + viewer backend for the battlefield generator.

Run:  uvicorn server.app:app --host 0.0.0.0 --port 8000
(from the project root, with the venv active)

Tile scheme: at zoom z, resolution is 2**z / 16 px per mm, so one 256px
tile covers 4096 / 2**z mm. Tiles are cached on (domain key, z, tx, ty);
shading modes reuse the cached height array.
"""

from __future__ import annotations

import base64
import datetime
import glob
import io
import json
import os
import re
import threading
from collections import OrderedDict

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image

from battlefield import Domain, Library, default_config, merge_config
from battlefield.config import load_preset, save_preset
from battlefield.render import heightmap_png_bytes, shade, to_png_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESET_DIR = os.path.join(ROOT, "presets")
LIBRARY_DIR = os.path.join(ROOT, "library")
TILE_PX = 256
APRON = 2  # extra pixels per side so hillshade gradients seam across tiles

app = FastAPI(title="Battlefield Heightmap Studio")

library = Library(LIBRARY_DIR)
_domains: dict[str, Domain] = {}
_domains_lock = threading.Lock()


class _LRU:
    def __init__(self, cap: int):
        self.cap = cap
        self.data: OrderedDict = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.cap:
                self.data.popitem(last=False)


_height_cache = _LRU(4000)   # (domain key, z, tx, ty) -> height array
_png_cache = _LRU(8000)      # (domain key, mode, z, tx, ty) -> png bytes


def _register(config: dict, seed: int) -> Domain:
    dom = Domain(config, seed, library=library)
    with _domains_lock:
        _domains[dom.key] = dom
    return dom


def _get_domain(key: str) -> Domain:
    with _domains_lock:
        dom = _domains.get(key)
    if dom is None:
        raise HTTPException(404, "unknown domain key; POST /api/config first")
    return dom


_DEFAULT_PRESET = os.path.join(PRESET_DIR, "nice looking v2.json")
try:
    _default_config, _default_seed = load_preset(_DEFAULT_PRESET)
except (OSError, ValueError):
    _default_config, _default_seed = default_config(), 42
_default_domain = _register(_default_config, _default_seed)


# ------------------------------------------------------------------ config

class ConfigIn(BaseModel):
    config: dict
    seed: int = 0


@app.get("/api/defaults")
def get_defaults():
    return {"config": merge_config(_default_config), "seed": _default_domain.seed,
            "key": _default_domain.key}


@app.post("/api/config")
def post_config(body: ConfigIn):
    dom = _register(merge_config(body.config), body.seed)
    lo, hi = dom.estimated_range()
    return {"key": dom.key, "height_range": [lo, hi]}


# ------------------------------------------------------------------ tiles

def _tile_heights(dom: Domain, z: int, tx: int, ty: int) -> np.ndarray:
    ck = (dom.key, z, tx, ty)
    h = _height_cache.get(ck)
    if h is None:
        ppm = (2.0 ** z) / 16.0
        tile_mm = TILE_PX / ppm
        apron_mm = APRON / ppm
        h = dom.render_region(tx * tile_mm - apron_mm, ty * tile_mm - apron_mm,
                              tile_mm + 2 * apron_mm, tile_mm + 2 * apron_mm,
                              ppm, lod=True)
        _height_cache.put(ck, h)
    return h


@app.get("/api/tile/{key}/{mode}/{z}/{tx}/{ty}.png")
def get_tile(key: str, mode: str, z: int, tx: int, ty: int):
    if mode not in ("hillshade", "grey", "color"):
        raise HTTPException(400, "bad mode")
    if not (0 <= z <= 12):
        raise HTTPException(400, "zoom out of range")
    pk = (key, mode, z, tx, ty)
    png = _png_cache.get(pk)
    if png is None:
        dom = _get_domain(key)
        h = _tile_heights(dom, z, tx, ty)
        ppm = (2.0 ** z) / 16.0
        rgb = shade(h, ppm, mode, height_range=dom.estimated_range())
        rgb = rgb[APRON:-APRON, APRON:-APRON]
        png = to_png_bytes(rgb)
        _png_cache.put(pk, png)
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "max-age=31536000, immutable"})


# ------------------------------------------------------------------ stamp

class StampIn(BaseModel):
    key: str
    x: float
    y: float
    w_mm: float = 25.0
    h_mm: float = 12.5
    rotation: float = 0.0
    px_per_mm: float | None = None
    mode: str = "hillshade"


@app.post("/api/stamp")
def post_stamp(body: StampIn):
    dom = _get_domain(body.key)
    ppm = body.px_per_mm or max(dom.config["px_per_mm"], 16.0)
    if body.w_mm * ppm > 4000 or body.h_mm * ppm > 4000:
        raise HTTPException(400, "stamp too large")
    h = dom.crop(body.x, body.y, body.w_mm, body.h_mm, body.rotation, ppm)
    mode = body.mode if body.mode in ("hillshade", "grey", "color") else "hillshade"
    rgb = shade(h, ppm, mode, height_range=dom.estimated_range())
    counts, edges = np.histogram(h, bins=48)
    return {
        "png": base64.b64encode(to_png_bytes(rgb)).decode(),
        "heightmap_png": base64.b64encode(heightmap_png_bytes(h)).decode(),
        "px_per_mm": ppm,
        "shape": list(h.shape),
        "stats": {
            "min": float(h.min()), "max": float(h.max()),
            "mean": float(h.mean()),
            "relief": float(h.max() - h.min()),
        },
        "histogram": {"counts": counts.tolist(),
                      "edges": [float(e) for e in edges]},
    }


# ------------------------------------------------------------------ bases

class BasesIn(BaseModel):
    key: str
    placement_seed: int = 1
    count: int = 6
    large_fraction: float = 0.33
    d_small: float = 25.0
    d_large: float = 32.0
    px_per_mm: float = 5.0
    spread_mm: float = 1500.0


@app.post("/api/bases")
def post_bases(body: BasesIn):
    """Example base crops for the 3D base viewer: deterministic positions/
    rotations from placement_seed, square height grids covering each disc."""
    from battlefield.noise import hash01

    dom = _get_domain(body.key)
    count = max(1, min(int(body.count), 24))
    # Viewer requests ~5 px/mm; STL export requests much higher (25 micron =
    # 40 px/mm). Clamp overall, then per-base so no single crop grid exceeds
    # ~2600 px/side (bounds memory + noise-eval time on the big discs).
    ppm = min(max(body.px_per_mm, 2.0), 50.0)
    out = []
    for i in range(count):
        def h(tag):
            return float(hash01(np.int64(i), np.int64(tag),
                                body.placement_seed & 0xFFFFFFFF))
        d = body.d_large if h(4) < body.large_fraction else body.d_small
        d = min(max(d, 5.0), 80.0)
        ppm_i = min(ppm, 2600.0 / d)
        x = (h(1) - 0.5) * body.spread_mm
        y = (h(2) - 0.5) * body.spread_mm
        rot = h(3) * 360.0
        crop = dom.crop(x, y, d, d, rot, ppm_i)
        out.append({
            "x": round(x, 2), "y": round(y, 2), "rotation": round(rot, 1),
            "diameter": d, "n": crop.shape[0], "px_per_mm": ppm_i,
            "heights_b64": base64.b64encode(
                crop.astype("<f4").tobytes()).decode(),
            "min": float(crop.min()), "max": float(crop.max()),
            "mean": float(crop.mean()),
        })
    return {"bases": out}


# ------------------------------------------------------------------ export log
#
# Every export gets a guid + versioned record (exports/<guid>.json and a
# line in exports.jsonl). The record pins schema version AND the generator
# git commit: determinism only holds for the same code, so a record is only
# exactly reproducible on the commit that produced it. QR codes on base
# bottoms encode <host>/b/<guid>, which stays a stable, version-free route;
# all versioning lives in the record itself.

EXPORT_SCHEMA = 1
EXPORT_LOG = os.path.join(ROOT, "exports.jsonl")
EXPORTS_DIR = os.path.join(ROOT, "exports")
_export_log_lock = threading.Lock()


def _git_commit() -> str:
    try:
        with open(os.path.join(ROOT, ".git", "HEAD")) as f:
            head = f.read().strip()
        if head.startswith("ref: "):
            with open(os.path.join(ROOT, ".git", head[5:])) as f:
                return f.read().strip()[:12]
        return head[:12]
    except OSError:
        return "unknown"


APP_COMMIT = _git_commit()
_GUID_RE = re.compile(r"^[0-9a-f]{12}$")


@app.post("/api/log_export")
def log_export(body: dict):
    """Store one versioned record per export (full base options, seeds,
    terrain config) under a fresh guid; returns the guid so the client can
    bake <host>/b/<guid> into the exported geometry as a QR code."""
    import secrets
    guid = secrets.token_hex(6)   # 12 hex chars -> QR stays at version 3
    entry = {"schema": EXPORT_SCHEMA, "guid": guid,
             "generator_commit": APP_COMMIT,
             "ts": datetime.datetime.now(datetime.timezone.utc)
                   .isoformat(timespec="seconds"), **body}
    os.makedirs(EXPORTS_DIR, exist_ok=True)
    with _export_log_lock:
        with open(os.path.join(EXPORTS_DIR, f"{guid}.json"), "w") as f:
            json.dump(entry, f, indent=1)
        with open(EXPORT_LOG, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    return {"ok": True, "guid": guid, "schema": EXPORT_SCHEMA,
            "generator_commit": APP_COMMIT}


def _load_export(guid: str) -> dict:
    if not _GUID_RE.match(guid):
        raise HTTPException(400, "bad guid")
    path = os.path.join(EXPORTS_DIR, f"{guid}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "no such export")
    with open(path) as f:
        return json.load(f)


@app.get("/api/exports/{guid}")
def get_export(guid: str):
    rec = _load_export(guid)
    rec["current_generator_commit"] = APP_COMMIT
    rec["reproducible_exactly"] = rec.get("generator_commit") == APP_COMMIT
    return rec


@app.get("/b/{guid}")
def export_page(guid: str):
    """The page a printed base's QR code lands on: the complete setup that
    produced it, plus a link to restore it live into the studio."""
    rec = _load_export(guid)
    bo = rec.get("base_opts", {})
    same = rec.get("generator_commit") == APP_COMMIT
    rows = "".join(
        f"<tr><td>{k}</td><td>{json.dumps(bo[k])}</td></tr>"
        for k in sorted(bo))
    warn = ("" if same else
            f"<p class='warn'>⚠ generated on commit <code>"
            f"{rec.get('generator_commit')}</code>; server now runs <code>"
            f"{APP_COMMIT}</code> — terrain may differ for the same seed.</p>")
    html = f"""<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>base {guid}</title>
<style>body{{font-family:system-ui,sans-serif;background:#181c22;color:#dde;
margin:0 auto;max-width:640px;padding:24px}}
a.btn{{display:inline-block;background:#3b82d0;color:#fff;padding:10px 18px;
border-radius:8px;text-decoration:none;margin:12px 0}}
table{{border-collapse:collapse;width:100%;font-size:14px}}
td{{border-bottom:1px solid #333;padding:4px 8px}}
td:first-child{{opacity:.7}} .warn{{color:#e0a030}}
code{{background:#242a33;padding:1px 5px;border-radius:4px}}
pre{{background:#12151a;padding:12px;border-radius:8px;overflow-x:auto;
font-size:12px}}</style>
<h2>Printed base — export <code>{guid}</code></h2>
<p>{rec.get("ts","")} · schema v{rec.get("schema","?")} · generator
<code>{rec.get("generator_commit","?")}</code> · terrain seed
<code>{rec.get("terrain",{}).get("seed","?")}</code> · placement seed
<code>{rec.get("placement_seed","?")}</code></p>
{warn}
<a class="btn" href="/?restore={guid}">Open this setup in the studio</a>
<h3>Base options</h3><table>{rows}</table>
<h3>Full record</h3><pre>{json.dumps(rec, indent=1)}</pre>"""
    return Response(content=html, media_type="text/html")


# ------------------------------------------------------------------ bases presets
# A bases preset embeds the full terrain preset (config + seed) plus the
# base-viewer options, so one file reproduces the whole thing.

BASES_PRESET_DIR = os.path.join(PRESET_DIR, "bases")


class BasesPresetIn(BaseModel):
    name: str
    base_opts: dict
    placement_seed: int
    config: dict
    seed: int


@app.get("/api/bases_presets")
def list_bases_presets():
    names = [os.path.splitext(os.path.basename(p))[0]
             for p in glob.glob(os.path.join(BASES_PRESET_DIR, "*.json"))]
    return {"presets": sorted(names)}


@app.post("/api/bases_presets")
def save_bases_preset(body: BasesPresetIn):
    if not _NAME_RE.match(body.name):
        raise HTTPException(400, "bad preset name")
    os.makedirs(BASES_PRESET_DIR, exist_ok=True)
    with open(os.path.join(BASES_PRESET_DIR, f"{body.name}.json"), "w") as f:
        json.dump({
            "base_opts": body.base_opts,
            "placement_seed": body.placement_seed,
            "terrain": {"seed": body.seed,
                        "config": merge_config(body.config)},
        }, f, indent=2, sort_keys=True)
    return {"ok": True}


@app.get("/api/bases_presets/{name}")
def load_bases_preset(name: str):
    if not _NAME_RE.match(name):
        raise HTTPException(400, "bad preset name")
    path = os.path.join(BASES_PRESET_DIR, f"{name}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "no such bases preset")
    with open(path) as f:
        data = json.load(f)
    config = merge_config(data.get("terrain", {}).get("config"))
    seed = int(data.get("terrain", {}).get("seed", 0))
    dom = _register(config, seed)
    return {"base_opts": data.get("base_opts", {}),
            "placement_seed": int(data.get("placement_seed", 1)),
            "config": config, "seed": seed, "key": dom.key,
            "height_range": list(dom.estimated_range())}


# ------------------------------------------------------------------ presets

_NAME_RE = re.compile(r"^[\w\- ]{1,64}$")


class PresetIn(BaseModel):
    name: str
    config: dict
    seed: int


@app.get("/api/presets")
def list_presets():
    names = [os.path.splitext(os.path.basename(p))[0]
             for p in glob.glob(os.path.join(PRESET_DIR, "*.json"))]
    return {"presets": sorted(names)}


@app.post("/api/presets")
def save_preset_ep(body: PresetIn):
    if not _NAME_RE.match(body.name):
        raise HTTPException(400, "bad preset name")
    os.makedirs(PRESET_DIR, exist_ok=True)
    save_preset(os.path.join(PRESET_DIR, f"{body.name}.json"),
                merge_config(body.config), body.seed)
    return {"ok": True}


@app.get("/api/presets/{name}")
def get_preset(name: str):
    if not _NAME_RE.match(name):
        raise HTTPException(400, "bad preset name")
    path = os.path.join(PRESET_DIR, f"{name}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "no such preset")
    config, seed = load_preset(path)
    dom = _register(config, seed)
    return {"config": config, "seed": seed, "key": dom.key}


# ------------------------------------------------------------------ library

@app.get("/api/library")
def list_library():
    out = []
    for entry_id in library.ids():
        entry = library.get(entry_id)
        out.append({"id": entry_id, "metadata": entry.metadata})
    return {"entries": out}


def _entry_or_404(entry_id: str):
    if "/" in entry_id or ".." in entry_id:
        raise HTTPException(400, "bad id")
    entry = library.get(entry_id)
    if entry is None:
        raise HTTPException(404, "no such library entry")
    return entry


@app.get("/api/library/{entry_id}/thumb.png")
def library_thumb(entry_id: str, size: int = 220):
    entry = _entry_or_404(entry_id)
    a = entry.array
    step = max(1, int(max(a.shape) / max(size, 32)))
    small = a[::step, ::step]
    rgb = shade(small, 1.0, "hillshade", height_range=(0.0, 1.0))
    return Response(to_png_bytes(rgb), media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/library/{entry_id}/preview.png")
def library_preview(entry_id: str, mode: str = "hillshade"):
    entry = _entry_or_404(entry_id)
    a = entry.array
    step = max(1, int(max(a.shape) / 1024))
    small = a[::step, ::step]
    if mode not in ("hillshade", "grey", "color"):
        mode = "hillshade"
    rgb = shade(small, 1.0, mode, height_range=(0.0, 1.0))
    return Response(to_png_bytes(rgb), media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.post("/api/library/refresh")
def library_refresh():
    library.refresh()
    return {"entries": library.ids()}


# ------------------------------------------------------------------ static

@app.get("/")
def index():
    return FileResponse(os.path.join(ROOT, "server", "static", "index.html"))


app.mount("/static", StaticFiles(directory=os.path.join(ROOT, "server", "static")),
          name="static")
