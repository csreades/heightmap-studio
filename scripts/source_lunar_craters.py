"""Extract real lunar crater DEM patches from NASA LRO LOLA LDEM_64.

LDEM_64 is the 64 px/deg (~473 m/px) global LOLA DEM (23040x11520 int16,
0.5 m/DN, equirectangular, lon 0..360E, lat +90..-90). Public domain
(NASA/US Government work, PDS archive). Instead of downloading the 530 MB
file, each patch fetches only its row block via an HTTP Range request.

Patches are corrected for the equirectangular longitude stretch
(resampled horizontally by cos(latitude)) so craters come out round,
then normalized into the library with plane-fit slope removal.

Run from the project root:  python scripts/source_lunar_craters.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from battlefield.library import import_map  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "library")
CACHE = os.path.join(tempfile.gettempdir(), "heightmap_source_cache")
UA = {"User-Agent": "heightmap-studio/1.0 (terrain research; PD sources)"}

URL = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
       "lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img")
PPD = 64                      # px per degree
W, H = 360 * PPD, 180 * PPD   # 23040 x 11520
KM_PER_PX = 30.3236 / PPD     # N-S km per pixel (1 deg lat = 30.32 km)

# (id, name/note, center lat, center lon E, crater diameter km)
CRATERS = [
    ("nasa_lola_tycho", "Tycho (85 km): fresh rayed crater, terraces + central peak",
     -43.31, 348.78, 85.0),
    ("nasa_lola_copernicus", "Copernicus (93 km): terraced walls, central peaks",
     9.62, 339.92, 93.0),
    ("nasa_lola_theophilus", "Theophilus (100 km): sharp rim, big central peak",
     -11.45, 26.28, 100.0),
    ("nasa_lola_king", "King (76 km): pristine farside impact",
     4.96, 120.49, 76.0),
    ("nasa_lola_aristarchus", "Aristarchus (40 km): young, steep bowl",
     23.73, 312.52, 40.0),
    ("nasa_lola_burg", "Buerg (40 km): bowl + central peak in Lacus Mortis",
     45.0, 28.23, 40.0),
]
# broad heavily-cratered field (not a single stamp): farside highlands
FIELD = ("nasa_lola_highlands", "farside southern highlands crater field",
         -35.0, 190.0, 512)  # last value = patch size in px


def fetch_rows(r0: int, r1: int) -> np.ndarray:
    """Fetch full-width row block [r0, r1) via one HTTP Range request."""
    start = r0 * W * 2
    end = r1 * W * 2 - 1
    req = urllib.request.Request(URL, headers={**UA, "Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        buf = r.read()
    return np.frombuffer(buf, dtype="<i2").reshape(r1 - r0, W)


def extract(lat: float, lon: float, size_px: int) -> tuple[np.ndarray, float]:
    """Round patch of size_px (N-S) centered at lat/lonE, stretch-corrected.

    Returns (patch float64, km per px)."""
    row = int(round((90.0 - lat) * PPD))
    col = int(round((lon % 360.0) * PPD))
    half = size_px // 2
    r0, r1 = max(0, row - half), min(H, row + half)
    block = fetch_rows(r0, r1)
    coslat = float(np.cos(np.deg2rad(lat)))
    # E-W ground distance per px shrinks by cos(lat): take a wider column
    # span, then squeeze horizontally so the patch is metrically square.
    half_c = int(round(half / coslat))
    cols = (np.arange(col - half_c, col + half_c) % W)  # wrap lon seam
    patch = block[:, cols].astype(np.float64)
    img = Image.fromarray(patch.astype(np.float32), mode="F")
    img = img.resize((r1 - r0, r1 - r0), Image.LANCZOS)
    return np.asarray(img, dtype=np.float64), KM_PER_PX


def save_patch(entry_id: str, note: str, lat: float, lon: float,
               patch: np.ndarray, km_px: float, extra_note: str = "") -> None:
    lo, hi = patch.min(), patch.max()
    png = ((patch - lo) / max(hi - lo, 1e-9) * 65535).astype(np.uint16)
    src = os.path.join(CACHE, f"{entry_id}_64.png")
    os.makedirs(CACHE, exist_ok=True)
    Image.fromarray(png).save(src)
    meta = {
        "name": note,
        "source": "NASA LRO LOLA GDR (LDEM_64), PDS Geosciences Node",
        "source_url": "https://pds-geosciences.wustl.edu/missions/lro/lola.htm",
        "file_url": URL,
        "license": "Public domain (NASA/US Government work; LRO/LOLA PDS archive)",
        "author": "NASA/GSFC LOLA team (Smith et al.)",
        "tags": ["crater", "lunar", "dem"],
        "original_resolution": "global 23040x11520 @ 64 px/deg (473 m/px)",
        "physical_scale_note": (f"patch centered lat={lat}, lonE={lon}; "
                                f"{km_px:.3f} km/px after cos(lat) longitude-"
                                f"stretch correction; elevation range "
                                f"{lo * 0.5:.0f}..{hi * 0.5:.0f} m. {extra_note}"),
    }
    import_map(src, LIB, entry_id, meta, strip="plane", max_size=1024)
    print(f"    OK {entry_id}  ({patch.shape[0]}px, {km_px:.2f} km/px)")


def main():
    print("real lunar craters from LOLA LDEM_64 (473 m/px, public domain):")
    for entry_id, note, lat, lon, d_km in CRATERS:
        try:
            # stamp footprint in the generator is 2x crater diameter
            size_px = int(round(2.2 * d_km / KM_PER_PX))
            patch, km_px = extract(lat, lon, size_px)
            save_patch(entry_id, note, lat, lon, patch, km_px,
                       f"crater diameter ~{d_km:.0f} km (~{d_km / km_px:.0f} px).")
        except Exception as e:
            print(f"    FAIL {entry_id}: {e}")
    entry_id, note, lat, lon, size_px = FIELD
    try:
        patch, km_px = extract(lat, lon, size_px)
        save_patch(entry_id, note, lat, lon, patch, km_px)
    except Exception as e:
        print(f"    FAIL {entry_id}: {e}")
    print("done.")


if __name__ == "__main__":
    main()
