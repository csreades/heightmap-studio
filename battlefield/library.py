"""Bump-map library: sourced greyscale heightmaps with provenance metadata.

Layout on disk:
    library/<entry_id>/height.png      16-bit greyscale, normalized 0..1
    library/<entry_id>/metadata.json   provenance + normalization notes

`import_map()` normalizes arbitrary source images into that layout:
optionally strips large-scale slope (high-pass), remaps to full range,
and records every applied step in the metadata.
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image

from . import noise

Image.MAX_IMAGE_PIXELS = None  # trust our own sources (large DEMs)


def _load_grey(path: str) -> np.ndarray:
    """Load any image as float64 greyscale in [0, 1]."""
    img = Image.open(path)
    if img.mode in ("I;16", "I;16B", "I"):
        arr = np.asarray(img, dtype=np.float64)
        arr /= 65535.0 if img.mode.startswith("I;16") else max(arr.max(), 1.0)
    elif img.mode == "F":
        arr = np.asarray(img, dtype=np.float64)
        lo, hi = arr.min(), arr.max()
        arr = (arr - lo) / (hi - lo) if hi > lo else np.zeros_like(arr)
    else:
        arr = np.asarray(img.convert("L"), dtype=np.float64) / 255.0
    return arr


class LibraryEntry:
    def __init__(self, entry_id: str, path: str):
        self.id = entry_id
        self.path = path
        with open(os.path.join(path, "metadata.json")) as f:
            self.metadata = json.load(f)
        self._array: np.ndarray | None = None
        self._edge_mean: float | None = None

    @property
    def array(self) -> np.ndarray:
        if self._array is None:
            self._array = _load_grey(os.path.join(self.path, "height.png"))
        return self._array

    @property
    def edge_mean(self) -> float:
        """Mean of border pixels -- reference level for crater stamps."""
        if self._edge_mean is None:
            a = self.array
            border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
            self._edge_mean = float(border.mean())
        return self._edge_mean

    @property
    def stamp_refs(self) -> tuple[float, float]:
        """(depth below edge level, p99 height above edge level) -- lets
        crater stamps scale bowl and rim independently."""
        if not hasattr(self, "_stamp_refs"):
            a = self.array
            neg = max(self.edge_mean - float(a.min()), 1e-3)
            above = (a - self.edge_mean).ravel()
            above = above[above > 0]
            pos = max(float(np.percentile(above, 99.0)) if above.size else 0.0,
                      1e-3)
            self._stamp_refs = (neg, pos)
        return self._stamp_refs

    def sample(self, u, v) -> np.ndarray:
        """Bilinear sample at continuous pixel-space coords (clamped)."""
        a = self.array
        h, w = a.shape
        u = np.clip(u, 0.0, w - 1.001)
        v = np.clip(v, 0.0, h - 1.001)
        u0 = u.astype(np.int64)
        v0 = v.astype(np.int64)
        fu = u - u0
        fv = v - v0
        top = a[v0, u0] * (1 - fu) + a[v0, u0 + 1] * fu
        bot = a[v0 + 1, u0] * (1 - fu) + a[v0 + 1, u0 + 1] * fu
        return top * (1 - fv) + bot * fv

    def sample_tiled(self, x_mm, y_mm, tile_mm: float, seed: int) -> np.ndarray:
        """Sample the map tiled over world space, with variation.

        Mirror-repeat tiling (seamless by construction) blended with a
        second rotated/offset sampling of the same map, masked by
        low-frequency noise, so repetition doesn't read at base scale.
        """
        a = self.array
        h, w = a.shape

        def mirrored(t):
            t = np.mod(t, 2.0)
            return np.where(t > 1.0, 2.0 - t, t)

        def take(xs, ys):
            return self.sample(mirrored(xs) * (w - 1), mirrored(ys) * (h - 1))

        s1 = take(x_mm / tile_mm, y_mm / tile_mm)
        ca, sa = np.cos(0.72), np.sin(0.72)
        rx = (ca * x_mm - sa * y_mm) / (tile_mm * 1.27) + 0.37
        ry = (sa * x_mm + ca * y_mm) / (tile_mm * 1.27) + 0.71
        s2 = take(rx, ry)
        m = noise.smoothstep(-0.25, 0.25, noise.fbm(
            x_mm, y_mm, noise.seed_for(seed, "libmix"),
            scale_mm=tile_mm * 0.9, octaves=2))
        return s1 * (1 - m) + s2 * m


class Library:
    def __init__(self, root: str = "library"):
        self.root = root
        self._entries: dict[str, LibraryEntry] = {}

    def refresh(self) -> None:
        self._entries = {}

    def ids(self) -> list[str]:
        if not os.path.isdir(self.root):
            return []
        return sorted(
            d for d in os.listdir(self.root)
            if os.path.isfile(os.path.join(self.root, d, "metadata.json"))
            and os.path.isfile(os.path.join(self.root, d, "height.png"))
        )

    def get(self, entry_id: str) -> LibraryEntry | None:
        if entry_id not in self._entries:
            path = os.path.join(self.root, entry_id)
            if not os.path.isfile(os.path.join(path, "metadata.json")):
                return None
            self._entries[entry_id] = LibraryEntry(entry_id, path)
        return self._entries[entry_id]


def import_map(src_path: str, root: str, entry_id: str, metadata: dict,
               max_size: int = 2048, strip: str = "highpass",
               percentile_clip: float = 0.5) -> str:
    """Normalize a source image into the library. Returns the entry path.

    strip: "highpass" (subtract heavy gaussian blur -- for texture tiles),
           "plane" (subtract best-fit plane -- for DEM patches where the
           large-scale feature IS the signal, e.g. craters), or "none".

    Steps (all recorded in metadata["normalization"]):
      - convert to greyscale float
      - downscale so the long edge is <= max_size
      - strip large-scale slope per `strip`
      - percentile-clip and remap to full 0..1 range
      - save as 16-bit PNG
    """
    from scipy.ndimage import gaussian_filter

    arr = _load_grey(src_path)
    steps = ["greyscale float conversion"]

    long_edge = max(arr.shape)
    if long_edge > max_size:
        factor = max_size / long_edge
        img = Image.fromarray((arr * 65535).astype(np.uint16))
        img = img.resize((max(1, int(arr.shape[1] * factor)),
                          max(1, int(arr.shape[0] * factor))),
                         Image.LANCZOS)
        arr = np.asarray(img, dtype=np.float64) / 65535.0
        steps.append(f"downscaled to {arr.shape[1]}x{arr.shape[0]} (lanczos)")

    if strip == "highpass":
        sigma = min(arr.shape) / 4.0
        arr = arr - gaussian_filter(arr, sigma=sigma)
        steps.append(f"large-scale slope stripped (gaussian high-pass, sigma={sigma:.0f}px)")
    elif strip == "plane":
        ys, xs = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]
        A = np.column_stack([xs.ravel(), ys.ravel(), np.ones(arr.size)])
        coef, *_ = np.linalg.lstsq(A, arr.ravel(), rcond=None)
        arr = arr - (A @ coef).reshape(arr.shape)
        steps.append("regional slope stripped (best-fit plane subtracted)")

    lo = np.percentile(arr, percentile_clip)
    hi = np.percentile(arr, 100.0 - percentile_clip)
    if hi <= lo:
        raise ValueError(f"{src_path}: degenerate height range")
    arr = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    steps.append(f"remapped to full range ({percentile_clip}..{100 - percentile_clip} percentile clip)")

    entry_path = os.path.join(root, entry_id)
    os.makedirs(entry_path, exist_ok=True)
    Image.fromarray((arr * 65535).astype(np.uint16)).save(
        os.path.join(entry_path, "height.png"))

    meta = dict(metadata)
    meta["normalization"] = steps
    meta["stored_resolution"] = [arr.shape[1], arr.shape[0]]
    with open(os.path.join(entry_path, "metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return entry_path
