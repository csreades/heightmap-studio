"""FastAPI tile server + viewer backend for the battlefield generator.

Run:  uvicorn server.app:app --host 0.0.0.0 --port 8000
(from the project root, with the venv active)

Tile scheme: at zoom z, resolution is 2**z / 16 px per mm, so one 256px
tile covers 4096 / 2**z mm. Tiles are cached on (domain key, z, tx, ty);
shading modes reuse the cached height array.
"""

from __future__ import annotations

import base64
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


_default_domain = _register(default_config(), 42)


# ------------------------------------------------------------------ config

class ConfigIn(BaseModel):
    config: dict
    seed: int = 0


@app.get("/api/defaults")
def get_defaults():
    return {"config": default_config(), "seed": _default_domain.seed,
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
    ppm = min(max(body.px_per_mm, 2.0), 12.0)
    out = []
    for i in range(count):
        def h(tag):
            return float(hash01(np.int64(i), np.int64(tag),
                                body.placement_seed & 0xFFFFFFFF))
        d = body.d_large if h(4) < body.large_fraction else body.d_small
        d = min(max(d, 5.0), 80.0)
        x = (h(1) - 0.5) * body.spread_mm
        y = (h(2) - 0.5) * body.spread_mm
        rot = h(3) * 360.0
        crop = dom.crop(x, y, d, d, rot, ppm)
        out.append({
            "x": round(x, 2), "y": round(y, 2), "rotation": round(rot, 1),
            "diameter": d, "n": crop.shape[0], "px_per_mm": ppm,
            "heights_b64": base64.b64encode(
                crop.astype("<f4").tobytes()).decode(),
            "min": float(crop.min()), "max": float(crop.max()),
            "mean": float(crop.mean()),
        })
    return {"bases": out}


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
