"""Shading/visualization of height arrays (viewer + CLI, not the pipeline)."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

# false-color height ramp (dark valley -> pale peak), terrain-ish
_RAMP = np.array([
    (40, 32, 66), (48, 66, 110), (49, 105, 122), (66, 138, 106),
    (119, 160, 92), (180, 175, 105), (222, 197, 145), (245, 230, 200),
], dtype=np.float64)


def hillshade(h: np.ndarray, px_per_mm: float, azimuth_deg: float = 315.0,
              altitude_deg: float = 45.0, z_exaggeration: float = 3.0) -> np.ndarray:
    """Standard Lambertian hillshade of a height array (mm). Returns [0,1]."""
    spacing = 1.0 / px_per_mm
    gy, gx = np.gradient(h * z_exaggeration, spacing)
    az = np.deg2rad(360.0 - azimuth_deg + 90.0)
    alt = np.deg2rad(altitude_deg)
    lx = np.cos(alt) * np.cos(az)
    ly = -np.cos(alt) * np.sin(az)
    lz = np.sin(alt)
    norm = np.sqrt(gx * gx + gy * gy + 1.0)
    shade = (-gx * lx - gy * ly + lz) / norm
    return np.clip(shade, 0.0, 1.0)


def _ramp_lookup(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0) * (len(_RAMP) - 1)
    i = np.clip(t.astype(np.int64), 0, len(_RAMP) - 2)
    f = (t - i)[..., None]
    return _RAMP[i] * (1 - f) + _RAMP[i + 1] * f


def shade(h: np.ndarray, px_per_mm: float, mode: str = "hillshade",
          height_range: tuple[float, float] | None = None) -> np.ndarray:
    """Turn a height array into a uint8 RGB image array."""
    if height_range is None:
        lo, hi = float(h.min()), float(h.max())
    else:
        lo, hi = height_range
    if hi <= lo:
        hi = lo + 1e-6
    t = (h - lo) / (hi - lo)

    if mode == "grey":
        g = np.clip(t * 255.0, 0, 255).astype(np.uint8)
        return np.stack([g, g, g], axis=-1)
    if mode == "color":
        rgb = _ramp_lookup(t)
        sh = hillshade(h, px_per_mm)[..., None]
        return np.clip(rgb * (0.35 + 0.75 * sh), 0, 255).astype(np.uint8)
    # hillshade with a faint height tint so flat areas still show elevation
    sh = hillshade(h, px_per_mm)
    base = 30.0 + 205.0 * sh
    tint = (t - 0.5) * 26.0
    rgb = np.stack([base + tint * 0.6, base + tint * 0.3, base - tint * 0.5],
                   axis=-1)
    return np.clip(rgb, 0, 255).astype(np.uint8)


def to_png_bytes(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()


def heightmap_png_bytes(h: np.ndarray, height_range: tuple[float, float] | None = None) -> bytes:
    """16-bit greyscale PNG of raw heights (for export/inspection)."""
    if height_range is None:
        lo, hi = float(h.min()), float(h.max())
    else:
        lo, hi = height_range
    if hi <= lo:
        hi = lo + 1e-6
    g = np.clip((h - lo) / (hi - lo) * 65535.0, 0, 65535).astype(np.uint16)
    buf = io.BytesIO()
    Image.fromarray(g).save(buf, format="PNG")
    return buf.getvalue()
