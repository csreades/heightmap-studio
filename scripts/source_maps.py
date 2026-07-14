"""Sourcing run: download CC0 / public-domain heightmaps into library/.

Sources (all verified free-to-use, no attribution required):
  - Poly Haven  (https://polyhaven.com/license)  -- everything CC0
  - ambientCG   (https://docs.ambientcg.com/license/) -- everything CC0
  - NASA LRO LOLA GDR DEM (PDS) -- US Government work, public domain

Every entry gets full provenance in metadata.json. Anything whose license
could not be confirmed is simply not in the manifest.

Run from the project root:  python scripts/source_maps.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from battlefield.library import import_map  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "library")
CACHE = os.path.join(tempfile.gettempdir(), "heightmap_source_cache")
UA = {"User-Agent": "heightmap-studio/1.0 (terrain research; CC0 sources only)"}

POLYHAVEN = [
    # (asset id, tags)
    ("mud_cracked_dry_03", ["cracked-earth", "dry-mud"]),
    ("mud_cracked_dry_riverbed_002", ["cracked-earth", "dry-mud", "riverbed"]),
    ("dry_ground_01", ["cracked-earth", "desert", "baked"]),
    ("aerial_mud_1", ["mud", "wheel-ruts", "tracks"]),
    ("aerial_ground_rock", ["rocky-ground", "dirt", "stones"]),
    ("rocks_ground_05", ["rocky-ground", "gravel", "rubble"]),
    ("aerial_asphalt_01", ["asphalt", "road", "cracked"]),
]

AMBIENTCG = [
    ("Gravel043", ["gravel", "fine"]),
    ("Road015C", ["asphalt", "damaged", "cracked"]),
    ("Ground105", ["dirt", "dry", "eroded"]),
]

# LOLA 16 px/deg global DEM: 5760x2880 int16 (LSB), 0.5 m/DN, ~1.9 km/px
LOLA_IMG = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
            "lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_16.img")
LOLA_LBL = LOLA_IMG.replace(".img", ".lbl")
LOLA_PATCHES = [
    # (id, center lat, center lon E, patch size px, tags, note)
    ("nasa_lola_tycho", -43.31, 348.78, 128, ["crater", "lunar", "dem"],
     "Tycho crater (~85 km diameter), bowl + rim + ejecta"),
    ("nasa_lola_copernicus", 9.62, 339.92, 128, ["crater", "lunar", "dem"],
     "Copernicus crater (~93 km diameter)"),
    ("nasa_lola_highlands", -35.0, 190.0, 256, ["crater-field", "lunar", "dem"],
     "heavily cratered farside southern highlands field"),
]


def fetch(url: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print(f"    downloading {url}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(dest + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dest + ".part", dest)
    return dest


def api_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def do_polyhaven(asset: str, tags: list[str]) -> None:
    entry_id = f"ph_{asset}"
    files = api_json(f"https://api.polyhaven.com/files/{asset}")
    info = api_json(f"https://api.polyhaven.com/info/{asset}")
    disp = files.get("Displacement")
    if not disp:
        print(f"    SKIP {asset}: no displacement map")
        return
    res = "2k" if "2k" in disp else sorted(disp)[0]
    url = disp[res]["png"]["url"]
    src = fetch(url, os.path.join(CACHE, f"{asset}_disp_{res}.png"))
    orig = max(disp.keys(), key=lambda k: int(k.rstrip("k")))
    meta = {
        "name": info.get("name", asset),
        "source": "Poly Haven",
        "source_url": f"https://polyhaven.com/a/{asset}",
        "file_url": url,
        "license": "CC0 1.0 (https://polyhaven.com/license)",
        "author": ", ".join(info.get("authors", {})) or "Poly Haven",
        "tags": tags + info.get("tags", [])[:8],
        "original_resolution": f"{orig} available; downloaded {res}",
        "physical_scale_mm": (info.get("dimensions")[0]
                              if info.get("dimensions") else None),
        "physical_scale_note": f"Poly Haven reported dimensions (mm): "
                               f"{info.get('dimensions')}, scale: {info.get('scale')}",
    }
    import_map(src, LIB, entry_id, meta, strip="highpass")
    print(f"    OK {entry_id}")


def do_ambientcg(asset: str, tags: list[str]) -> None:
    entry_id = f"acg_{asset.lower()}"
    d = api_json("https://ambientcg.com/api/v2/full_json?id=" + asset +
                 "&include=downloadData,tagData,displayData,dimensionsData")
    found = d.get("foundAssets") or []
    if not found:
        print(f"    SKIP {asset}: not found")
        return
    a = found[0]
    zip_name = f"{asset}_2K-PNG.zip"
    url = f"https://ambientcg.com/get?file={zip_name}"
    src_zip = fetch(url, os.path.join(CACHE, zip_name))
    with zipfile.ZipFile(src_zip) as z:
        disp_names = [n for n in z.namelist() if "Displacement" in n]
        if not disp_names:
            print(f"    SKIP {asset}: no displacement in zip")
            return
        raw = z.read(disp_names[0])
    src = os.path.join(CACHE, f"{asset}_Displacement.png")
    with open(src, "wb") as f:
        f.write(raw)
    dims = (a.get("dimensionX"), a.get("dimensionY"))
    meta = {
        "name": a.get("displayName", asset),
        "source": "ambientCG",
        "source_url": f"https://ambientcg.com/view?id={asset}",
        "file_url": url,
        "license": "CC0 1.0 (https://docs.ambientcg.com/license/)",
        "author": "ambientCG (Lennart Demes)",
        "tags": tags + (a.get("tags") or [])[:8],
        "original_resolution": "up to 8K available; downloaded 2K PNG",
        "physical_scale_mm": dims[0] * 10 if dims[0] else None,
        "physical_scale_note": f"ambientCG reported dimensions (cm): {dims}",
    }
    import_map(src, LIB, entry_id, meta, strip="highpass")
    print(f"    OK {entry_id}")


def do_lola() -> None:
    img_path = fetch(LOLA_IMG, os.path.join(CACHE, "ldem_16.img"))
    fetch(LOLA_LBL, os.path.join(CACHE, "ldem_16.lbl"))
    W, H = 5760, 2880  # 16 px/deg, lon 0..360 E, lat +90..-90
    dem = np.memmap(img_path, dtype="<i2", mode="r", shape=(H, W))
    for entry_id, lat, lon, size, tags, note in LOLA_PATCHES:
        col = int(round(lon * 16))
        row = int(round((90.0 - lat) * 16))
        half = size // 2
        r0, r1 = max(0, row - half), min(H, row + half)
        c0, c1 = max(0, col - half), min(W, col + half)
        patch = np.asarray(dem[r0:r1, c0:c1], dtype=np.float64)
        lo, hi = patch.min(), patch.max()
        png = ((patch - lo) / max(hi - lo, 1e-9) * 65535).astype(np.uint16)
        src = os.path.join(CACHE, f"{entry_id}.png")
        Image.fromarray(png).save(src)
        km_per_px = 1.895 * float(np.cos(np.deg2rad(lat)))
        meta = {
            "name": note,
            "source": "NASA LRO LOLA GDR (LDEM_16), PDS Geosciences Node",
            "source_url": "https://pds-geosciences.wustl.edu/missions/lro/lola.htm",
            "file_url": LOLA_IMG,
            "license": "Public domain (NASA/US Government work; LRO/LOLA PDS archive)",
            "author": "NASA/GSFC LOLA team (Smith et al.)",
            "tags": tags,
            "original_resolution": "global 5760x2880 @ 16 px/deg, 0.5 m/DN",
            "physical_scale_note": (f"patch {size}px centered lat={lat}, lonE={lon}; "
                                    f"~{km_per_px:.2f} km/px E-W at center, 1.895 km/px N-S; "
                                    f"elevation range {lo * 0.5:.0f}..{hi * 0.5:.0f} m"),
        }
        import_map(src, LIB, entry_id, meta, strip="plane", max_size=512)
        print(f"    OK {entry_id}")


def main():
    os.makedirs(LIB, exist_ok=True)
    print("Poly Haven (CC0):")
    for asset, tags in POLYHAVEN:
        try:
            do_polyhaven(asset, tags)
        except Exception as e:
            print(f"    FAIL {asset}: {e}")
    print("ambientCG (CC0):")
    for asset, tags in AMBIENTCG:
        try:
            do_ambientcg(asset, tags)
        except Exception as e:
            print(f"    FAIL {asset}: {e}")
    print("NASA LOLA (public domain):")
    try:
        do_lola()
    except Exception as e:
        print(f"    FAIL lola: {e}")
    print("done.")


if __name__ == "__main__":
    main()
