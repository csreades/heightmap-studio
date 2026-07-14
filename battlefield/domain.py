"""The procedural battlefield domain.

A Domain is a layered heightfield definition. It is effectively unbounded:
any region can be rendered on demand, deterministically, without ever
materializing the whole domain. Heights are in mm of physical relief;
coordinates are world-mm.
"""

from __future__ import annotations

import numpy as np

from . import layers
from .config import config_hash, merge_config
from .library import Library


class Domain:
    def __init__(self, config: dict | None = None, seed: int = 0,
                 library: Library | None = None):
        self.config = merge_config(config)
        self.seed = int(seed)
        self.library = library if library is not None else Library()

    @property
    def key(self) -> str:
        return config_hash(self.config, self.seed)

    def estimated_range(self) -> tuple[float, float]:
        """Approximate (min, max) height in mm, for display normalization."""
        L = self.config["layers"]
        m = self.config["master_amplitude"]
        lo = hi = 0.0
        if L["ground"]["enabled"]:
            a = L["ground"]["amplitude_mm"] + L["ground"]["roughness_amplitude_mm"]
            lo -= a
            hi += a
        if L["cracks"]["enabled"]:
            lo -= L["cracks"]["depth_mm"]
        if L["craters"]["enabled"]:
            d = L["craters"]["depth_per_radius"] * L["craters"]["max_radius_mm"]
            lo -= d * 0.9
            hi += d * L["craters"]["rim_height_rel"]
        if L["plates"]["enabled"]:
            hi += L["plates"]["plate_height_mm"] + L["plates"]["height_var_mm"]
        if L["detail"]["enabled"]:
            lo -= L["detail"]["amplitude_mm"]
            hi += L["detail"]["amplitude_mm"]
        if lo == hi:
            lo, hi = -1.0, 1.0
        return lo * m, hi * m

    # ------------------------------------------------------------ core

    def height_at(self, X: np.ndarray, Y: np.ndarray,
                  lod_ppm: float | None = None) -> np.ndarray:
        """Evaluate the composited heightfield at arbitrary world-mm coords.

        lod_ppm (px per mm) enables display-only level-of-detail: sub-pixel
        features are faded/skipped. Leave None for exact output (crops).
        """
        X = np.asarray(X, dtype=np.float64)
        Y = np.asarray(Y, dtype=np.float64)
        L = self.config["layers"]
        grid = layers.CoordGrid(X, Y)
        shape = np.broadcast(X, Y).shape

        if L["ground"]["enabled"]:
            h, macro = layers.ground_layer(X, Y, self.seed, L["ground"], lod_ppm)
        else:
            h = np.zeros(shape, dtype=np.float64)
            macro = np.zeros(shape, dtype=np.float64)

        crater_h = None
        crater_clear = None
        if L["craters"]["enabled"]:
            crater_h, crater_clear = layers.crater_field(
                grid, self.seed, L["craters"], self.library, lod_ppm)

        crack = None
        if L["cracks"]["enabled"]:
            crack = layers.crack_layer(X, Y, self.seed, L["cracks"], self.library)
            if crater_clear is not None:
                # impacts wipe the cracked surface inside bowls/rims
                strength = float(L["craters"].get("crack_clearing", 0.85))
                crack = crack * (1.0 - strength * crater_clear)
            if L["cracks"].get("blend") == "min":
                h = np.minimum(h, macro + crack)
            else:
                h = h + crack

        plate_w = None
        if L["plates"]["enabled"]:
            pw, prel = layers.plate_field(grid, self.seed, L["plates"])
            if crater_clear is not None:
                pw = pw * (1.0 - crater_clear)  # impacts shatter the paving
            h = h * (1.0 - pw) + (macro * 0.8 + prel) * pw
            plate_w = pw

        if crater_h is not None:
            h = h + crater_h

        road_w = None
        if L["roads"]["enabled"]:
            road_w, road_rel = layers.road_field(grid, self.seed, L["roads"])
            if crater_clear is not None:
                # impacts blow the road away inside bowls/rims (same as
                # plates) -- craters must interrupt roads, not be flattened
                road_w = road_w * (1.0 - crater_clear)
            target = macro * 0.85 + road_rel
            cs = L["roads"].get("crack_surface", 0.0)
            if crack is not None and cs > 0:
                target = target + crack * cs
            h = h * (1.0 - road_w) + target * road_w

        if L["detail"]["enabled"]:
            amp = L["detail"]["amplitude_mm"]
            if lod_ppm is not None:
                amp *= float(layers.noise.smoothstep(
                    0.2, 1.0, L["detail"]["scale_mm"] * lod_ppm))
            if amp > 0:
                det = layers.fbm(X, Y, layers.seed_for(self.seed, "detail"),
                                 L["detail"]["scale_mm"],
                                 octaves=int(L["detail"]["octaves"])) * amp
                if road_w is not None:
                    det = det * (1.0 - 0.5 * road_w)
                if plate_w is not None:
                    det = det * (1.0 - 0.6 * plate_w)
                h = h + det

        return h * self.config["master_amplitude"]

    # ------------------------------------------------------------ regions

    def render_region(self, x: float, y: float, w_mm: float, h_mm: float,
                      px_per_mm: float, lod: bool = False) -> np.ndarray:
        """Render an axis-aligned region. (x, y) is the top-left corner in
        world mm; returns a (h_mm*ppm, w_mm*ppm) float array of mm heights.

        Pixel centers sit at x + (i + 0.5)/ppm, so adjacent regions share
        exact sample coordinates and seam perfectly.
        """
        ppm = float(px_per_mm)
        nx = max(1, int(round(w_mm * ppm)))
        ny = max(1, int(round(h_mm * ppm)))
        xs = x + (np.arange(nx) + 0.5) / ppm
        ys = y + (np.arange(ny) + 0.5) / ppm
        X, Y = np.meshgrid(xs, ys)
        return self.height_at(X, Y, lod_ppm=ppm if lod else None)

    def crop(self, x: float, y: float, w_mm: float, h_mm: float,
             rotation: float = 0.0, px_per_mm: float | None = None) -> np.ndarray:
        """Heightmap crop for a base. (x, y) is the crop CENTER in world mm;
        rotation in degrees (counter-clockwise in world coords). Returns a
        (h_mm*ppm, w_mm*ppm) float array of mm heights, ready for mesh
        displacement.

        Rotation is exact: the field is evaluated directly at rotated
        sample coordinates -- no resampling/interpolation.
        """
        ppm = float(px_per_mm if px_per_mm is not None else self.config["px_per_mm"])
        nx = max(1, int(round(w_mm * ppm)))
        ny = max(1, int(round(h_mm * ppm)))
        us = -w_mm / 2.0 + (np.arange(nx) + 0.5) / ppm
        vs = -h_mm / 2.0 + (np.arange(ny) + 0.5) / ppm
        U, V = np.meshgrid(us, vs)
        th = np.deg2rad(rotation)
        ca, sa = np.cos(th), np.sin(th)
        X = x + ca * U - sa * V
        Y = y + sa * U + ca * V
        return self.height_at(X, Y)
