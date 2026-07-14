"""Terrain layers: cracked earth, craters, roads.

Every layer is evaluated pointwise from world coordinates (mm) + seed.
Features (craters, road segments) are spawned deterministically from
integer grid cells, so any region can be rendered independently and
adjacent regions agree exactly. All feature influence functions reach
exact zero at a bounded distance, so which cells get collected for a
given bounding box can never change the result.
"""

from __future__ import annotations

import numpy as np

from . import noise
from .noise import fbm, hash01, seed_for, smoothstep, worley_edge


class CoordGrid:
    """Coordinate arrays plus fast window slicing for regular grids.

    render_region produces axis-aligned monotonic grids -- feature stamps
    can then be sliced to small windows instead of touching every pixel.
    Rotated crops fall back to whole-array operations (crops are small).
    """

    def __init__(self, X: np.ndarray, Y: np.ndarray):
        self.X = X
        self.Y = Y
        self.separable = False
        if X.ndim == 2 and X.shape == Y.shape and X.shape[0] > 1 and X.shape[1] > 1:
            if (np.array_equal(X[0], X[-1]) and np.array_equal(Y[:, 0], Y[:, -1])
                    and X[0, 0] < X[0, -1] and Y[0, 0] < Y[-1, 0]):
                self.separable = True
                self.xs = X[0]
                self.ys = Y[:, 0]

    def window(self, x0: float, x1: float, y0: float, y1: float):
        """Slices covering [x0,x1]x[y0,y1], or full-array if not a grid.

        Returns None if the window is empty.
        """
        if not self.separable:
            return (slice(None),) if self.X.ndim == 1 else (slice(None), slice(None))
        ix0 = np.searchsorted(self.xs, x0, "left")
        ix1 = np.searchsorted(self.xs, x1, "right")
        iy0 = np.searchsorted(self.ys, y0, "left")
        iy1 = np.searchsorted(self.ys, y1, "right")
        if ix0 >= ix1 or iy0 >= iy1:
            return None
        return (slice(iy0, iy1), slice(ix0, ix1))

    @property
    def bounds(self):
        return (float(self.X.min()), float(self.X.max()),
                float(self.Y.min()), float(self.Y.max()))


# ---------------------------------------------------------------- ground

def ground_layer(X, Y, seed: int, cfg: dict, lod_ppm: float | None = None):
    """Returns (height, macro): full ground relief and the macro-only
    component (roads flatten toward the macro surface)."""
    macro = fbm(X, Y, seed_for(seed, "ground"), cfg["scale_mm"],
                octaves=int(cfg["octaves"]), lacunarity=cfg["lacunarity"],
                gain=cfg["gain"]) * cfg["amplitude_mm"]
    amp = cfg["roughness_amplitude_mm"]
    if lod_ppm is not None:  # fade sub-pixel roughness (display-only LOD)
        amp *= float(noise.smoothstep(0.2, 1.0, cfg["roughness_scale_mm"] * lod_ppm))
    if amp > 0:
        rough = fbm(X, Y, seed_for(seed, "rough"), cfg["roughness_scale_mm"],
                    octaves=2) * amp
        return macro + rough, macro
    return macro.copy(), macro


# ---------------------------------------------------------------- cracks

def crack_layer(X, Y, seed: int, cfg: dict, library=None):
    """Cracked-earth network as negative displacement (values <= 0)."""
    s = seed_for(seed, "cracks")
    entry = library.get(cfg["source"]) if (library and cfg.get("source")) else None
    if entry is not None:
        v = entry.sample_tiled(X, Y, cfg["source_tile_mm"], s)
        if cfg.get("source_invert"):
            v = 1.0 - v
        crack = np.power(np.clip(1.0 - v, 0.0, 1.0), cfg["falloff"])
        return -cfg["depth_mm"] * crack

    wx, wy = X, Y
    if cfg.get("warp_mm", 0) > 0:
        warp = cfg["warp_mm"]
        wscale = cfg["cell_mm"] * 1.7
        wx = X + warp * fbm(X, Y, seed_for(s, "wx"), wscale, octaves=2)
        wy = Y + warp * fbm(X, Y, seed_for(s, "wy"), wscale, octaves=2)
    edge, _f1 = worley_edge(wx, wy, s, cfg["cell_mm"], jitter=cfg["jitter"])
    # edge==0 on cell borders; carve where within crack width
    t = 1.0 - smoothstep(0.0, max(cfg["width_mm"], 1e-6), edge)
    crack = np.power(t, cfg["falloff"])
    return -cfg["depth_mm"] * crack


# ---------------------------------------------------------------- craters

def _crater_list(bounds, seed: int, cfg: dict):
    """Deterministic crater set near a bounding box, sorted oldest-first."""
    spacing = cfg["spacing_mm"]
    max_r = cfg["max_radius_mm"]
    pad = 2.0 * max_r + spacing
    x0, x1, y0, y1 = bounds
    cx0 = int(np.floor((x0 - pad) / spacing))
    cx1 = int(np.floor((x1 + pad) / spacing))
    cy0 = int(np.floor((y0 - pad) / spacing))
    cy1 = int(np.floor((y1 + pad) / spacing))
    gx, gy = np.meshgrid(np.arange(cx0, cx1 + 1), np.arange(cy0, cy1 + 1))
    gx = gx.ravel()
    gy = gy.ravel()

    keep = hash01(gx, gy, seed_for(seed, "spawn")) < cfg["probability"]
    gx, gy = gx[keep], gy[keep]
    if gx.size == 0:
        return []

    px = (gx + 0.15 + 0.7 * hash01(gx, gy, seed_for(seed, "px"))) * spacing
    py = (gy + 0.15 + 0.7 * hash01(gx, gy, seed_for(seed, "py"))) * spacing
    r_lo, r_hi = cfg["min_radius_mm"], cfg["max_radius_mm"]
    t = hash01(gx, gy, seed_for(seed, "r"))
    radius = r_lo * (r_hi / r_lo) ** t if r_lo > 0 else r_hi * t
    age = hash01(gx, gy, seed_for(seed, "age"))
    rot = hash01(gx, gy, seed_for(seed, "rot")) * 2.0 * np.pi
    pick = hash01(gx, gy, seed_for(seed, "pick"))
    sel = hash01(gx, gy, seed_for(seed, "sel"))

    # keep craters whose footprint (2r) can reach the box
    reach = 2.0 * radius
    near = ((px + reach >= x0) & (px - reach <= x1) &
            (py + reach >= y0) & (py - reach <= y1))
    order = np.lexsort((gx[near], gy[near], age[near]))  # oldest first
    fields = [f[near][order] for f in (px, py, radius, rot, pick, sel)]
    return list(zip(*[f.tolist() for f in fields]))


def _analytic_profile(rn, radius, cfg):
    """Crater profile vs normalized radius rn (0..2): bowl, rim, ejecta."""
    depth = cfg["depth_per_radius"] * radius
    rim_h = depth * cfg["rim_height_rel"]
    rim_w = max(cfg["rim_width_rel"], 0.02)
    bowl = np.where(rn < 1.0, (rn * rn - 1.0) * depth, 0.0)
    rim = rim_h * np.exp(-((rn - 1.0) / rim_w) ** 2)
    ejecta = np.where(
        rn >= 1.0,
        rim_h * 0.3 * np.exp(-(rn - 1.0) / max(cfg["ejecta_falloff"], 0.05)),
        0.0)
    return bowl + rim + ejecta


def crater_field(grid: CoordGrid, seed: int, cfg: dict, library=None,
                 lod_ppm: float | None = None):
    """Composited crater layer. Newer craters locally replace older ones'
    contribution before the layer is added onto the terrain.

    Returns (heights, clear): clear is 1 inside bowls/rims fading to 0
    past the rim -- the impact "wipes" other surface detail (cracks)."""
    ch = np.zeros(grid.X.shape, dtype=np.float64)
    clear = np.zeros(grid.X.shape, dtype=np.float64)
    craters = _crater_list(grid.bounds, seed, cfg)
    if not craters:
        return ch, clear

    # source may be a single library id or a pool of ids; each crater
    # deterministically picks one stamp from the pool
    src = cfg.get("source")
    ids = [src] if isinstance(src, str) else list(src or [])
    entries = [e for e in ((library.get(i) if library else None) for i in ids)
               if e is not None]
    src_mix = float(cfg.get("source_mix", 1.0))

    for px, py, radius, rot, pick, sel in craters:
        if lod_ppm is not None and 2.0 * radius * lod_ppm < 1.2:
            continue  # sub-pixel at this zoom (display-only LOD)
        foot = 2.0 * radius
        win = grid.window(px - foot, px + foot, py - foot, py + foot)
        if win is None:
            continue
        dx = grid.X[win] - px
        dy = grid.Y[win] - py
        rn = np.hypot(dx, dy) / radius
        w = 1.0 - smoothstep(1.6, 2.0, rn)
        if not w.any():
            continue
        if entries and pick < src_mix:
            entry = entries[int(sel * len(entries)) % len(entries)]
            ca, sa = np.cos(rot), np.sin(rot)
            u = np.clip((ca * dx - sa * dy) / foot * 0.5 + 0.5, 0.0, 1.0)
            v = np.clip((sa * dx + ca * dy) / foot * 0.5 + 0.5, 0.0, 1.0)
            h, wpx = entry.array.shape
            sample = entry.sample(u * (wpx - 1), v * (h - 1))
            depth = cfg["depth_per_radius"] * radius
            # scale bowl and rim independently: real lunar rim/depth ratios
            # (~0.2) read far too weak at miniature scale
            neg_ref, pos_ref = entry.stamp_refs
            rel = sample - entry.edge_mean
            rim_h = depth * cfg["rim_height_rel"]
            p = (np.minimum(rel, 0.0) * (depth / neg_ref)
                 + np.maximum(rel, 0.0) * (rim_h / pos_ref))
            # fade stamp to zero toward its square footprint edge
            w = w * (1.0 - smoothstep(0.7, 0.98, np.maximum(np.abs(u - 0.5),
                                                            np.abs(v - 0.5)) * 2.0))
        else:
            p = _analytic_profile(rn, radius, cfg)
        ch[win] = ch[win] * (1.0 - w) + p * w
        clear[win] = np.maximum(clear[win],
                                1.0 - smoothstep(1.05, 1.45, rn))
    return ch, clear


# ---------------------------------------------------------------- roads

def _road_polylines(bounds, seed: int, cfg: dict):
    """Deterministic road-network polylines near a bounding box.

    Nodes live on a jittered grid; edges connect neighbor nodes by hash
    probability; each edge is bent by midpoint displacement (3 levels).
    """
    spacing = cfg["spacing_mm"]
    reach = cfg["width_mm"] * 0.5 + cfg["shoulder_mm"] + 6.0 * max(
        cfg["berm_width_mm"], cfg["rut_width_mm"], 0.1) + cfg["rut_offset_mm"]
    pad = spacing * (1.5 + cfg["wobble"]) + reach
    x0, x1, y0, y1 = bounds
    cx0 = int(np.floor((x0 - pad) / spacing))
    cx1 = int(np.floor((x1 + pad) / spacing))
    cy0 = int(np.floor((y0 - pad) / spacing))
    cy1 = int(np.floor((y1 + pad) / spacing))

    s_nx = seed_for(seed, "nodex")
    s_ny = seed_for(seed, "nodey")

    def node(ix, iy):
        jx = float(hash01(np.int64(ix), np.int64(iy), s_nx))
        jy = float(hash01(np.int64(ix), np.int64(iy), s_ny))
        return ((ix + 0.2 + 0.6 * jx) * spacing,
                (iy + 0.2 + 0.6 * jy) * spacing)

    def bent(a, b, edge_seed):
        pts = [np.array(a), np.array(b)]
        for level in range(3):
            out = [pts[0]]
            for i in range(len(pts) - 1):
                p, q = pts[i], pts[i + 1]
                d = q - p
                seg = np.hypot(*d)
                if seg > 1e-9:
                    perp = np.array([-d[1], d[0]]) / seg
                    off = (float(hash01(np.int64(level), np.int64(i), edge_seed))
                           - 0.5) * cfg["wobble"] * seg
                    out.append((p + q) * 0.5 + perp * off)
                out.append(q)
            pts = out
        for _ in range(2):  # Chaikin corner cutting -> smooth winding curve
            out = [pts[0]]
            for i in range(len(pts) - 1):
                p, q = pts[i], pts[i + 1]
                out.append(p * 0.75 + q * 0.25)
                out.append(p * 0.25 + q * 0.75)
            out.append(pts[-1])
            pts = out
        return pts

    polylines = []
    s_e = seed_for(seed, "edge_e")
    s_s = seed_for(seed, "edge_s")
    s_d = seed_for(seed, "edge_d")
    for iy in range(cy0, cy1 + 1):
        for ix in range(cx0, cx1 + 1):
            a = node(ix, iy)
            if float(hash01(np.int64(ix), np.int64(iy), s_e)) < cfg["edge_probability"]:
                polylines.append(bent(a, node(ix + 1, iy),
                                      seed_for(seed, f"be{ix},{iy}")))
            if float(hash01(np.int64(ix), np.int64(iy), s_s)) < cfg["edge_probability"]:
                polylines.append(bent(a, node(ix, iy + 1),
                                      seed_for(seed, f"bs{ix},{iy}")))
            if float(hash01(np.int64(ix), np.int64(iy), s_d)) < cfg["junction_probability"]:
                polylines.append(bent(a, node(ix + 1, iy + 1),
                                      seed_for(seed, f"bd{ix},{iy}")))
    return polylines, reach


def road_field(grid: CoordGrid, seed: int, cfg: dict):
    """Returns (w, rel): corridor blend weight in [0,1] (exactly 0 away
    from roads) and the road-relative relief (offset + berms + ruts)."""
    seed = seed_for(seed, "roads")
    shape = grid.X.shape
    polylines, reach = _road_polylines(grid.bounds, seed, cfg)
    dmin = np.full(shape, np.inf)

    for pts in polylines:
        arr = np.asarray(pts)
        bx0, by0 = arr.min(axis=0)
        bx1, by1 = arr.max(axis=0)
        win = grid.window(bx0 - reach, bx1 + reach, by0 - reach, by1 + reach)
        if win is None:
            continue
        Xw = grid.X[win]
        Yw = grid.Y[win]
        d = dmin[win]
        for i in range(len(arr) - 1):
            ax, ay = arr[i]
            bx, by = arr[i + 1]
            ddx, ddy = bx - ax, by - ay
            L2 = ddx * ddx + ddy * ddy
            if L2 < 1e-12:
                continue
            t = np.clip(((Xw - ax) * ddx + (Yw - ay) * ddy) / L2, 0.0, 1.0)
            d = np.minimum(d, np.hypot(Xw - (ax + t * ddx), Yw - (ay + t * ddy)))
        dmin[win] = d

    hw = cfg["width_mm"] * 0.5
    finite = np.isfinite(dmin)
    d = np.where(finite, dmin, hw + cfg["shoulder_mm"] + reach)

    w = 1.0 - smoothstep(hw, hw + max(cfg["shoulder_mm"], 1e-6), d)

    rel = np.full(shape, cfg["offset_mm"])
    if cfg["berm_height_mm"] > 0:
        bw = max(cfg["berm_width_mm"], 1e-6)
        bc = hw + 0.45 * bw
        berm = cfg["berm_height_mm"] * np.exp(-((d - bc) / bw) ** 2)
        rel += np.where(d < bc + 6.0 * bw, berm, 0.0)
    if cfg["rut_depth_mm"] > 0:
        rw = max(cfg["rut_width_mm"], 1e-6)
        rut = cfg["rut_depth_mm"] * np.exp(-((d - cfg["rut_offset_mm"]) / rw) ** 2)
        rel -= np.where(d < cfg["rut_offset_mm"] + 6.0 * rw, rut, 0.0)
    return w, rel


# ---------------------------------------------------------------- plates

def plate_field(grid: CoordGrid, seed: int, cfg: dict):
    """Big concrete tiles on a rotated grid, in noise-driven patches.

    Returns (w, rel): plate blend weight in [0,1] (0 in joints and off the
    paving) and plate-relative relief (lift + per-tile tilt + cracks on
    broken tiles). Purely pointwise -- no feature loops.
    """
    s = seed_for(seed, "plates")
    X, Y = grid.X, grid.Y
    t = max(cfg["tile_mm"], 1e-3)
    th = np.deg2rad(cfg["rotation_deg"])
    ca, sa = np.cos(th), np.sin(th)
    u = (ca * X + sa * Y) / t
    v = (-sa * X + ca * Y) / t
    cu = np.floor(u).astype(np.int64)
    cv = np.floor(v).astype(np.int64)
    fu = u - cu
    fv = v - cv

    # patch coverage decided per tile (at its center -> whole tiles in/out)
    ucx = (cu + 0.5) * t
    vcy = (cv + 0.5) * t
    tcx = ca * ucx - sa * vcy
    tcy = sa * ucx + ca * vcy
    cov = fbm(tcx, tcy, seed_for(s, "cov"), cfg["patch_scale_mm"], octaves=2)
    score = (0.5 + 0.5 * cov) * 0.75 + 0.25 * hash01(cu, cv, seed_for(s, "keep"))
    present = score < cfg["coverage"]
    present &= hash01(cu, cv, seed_for(s, "gone")) >= cfg["missing_probability"]

    # joints: weight fades to 0 at tile borders so the ground shows through
    d_edge = np.minimum(np.minimum(fu, 1.0 - fu), np.minimum(fv, 1.0 - fv)) * t
    jw = cfg["joint_width_mm"] * 0.5
    w = np.where(present,
                 smoothstep(jw, jw + max(cfg["bevel_mm"], 1e-3), d_edge), 0.0)

    # per-tile lift + tilt (uneven, subsided slabs)
    lift = (cfg["plate_height_mm"]
            + (hash01(cu, cv, seed_for(s, "lift")) - 0.5) * 2.0 * cfg["height_var_mm"])
    gx = (hash01(cu, cv, seed_for(s, "tx")) - 0.5) * 2.0 * cfg["tilt_mm"]
    gy = (hash01(cu, cv, seed_for(s, "ty")) - 0.5) * 2.0 * cfg["tilt_mm"]
    rel = lift + (fu - 0.5) * gx + (fv - 0.5) * gy

    # some tiles are broken: worley cracks, decorrelated per tile
    if cfg["crack_depth_mm"] > 0 and cfg["broken_probability"] > 0:
        broken = hash01(cu, cv, seed_for(s, "broken")) < cfg["broken_probability"]
        offs = hash01(cu, cv, seed_for(s, "co")) * 977.0
        edge, _ = worley_edge(X + offs, Y - offs, seed_for(s, "wcrack"),
                              cfg["crack_cell_mm"])
        cmask = np.power(1.0 - smoothstep(0.0, max(cfg["crack_width_mm"], 1e-6),
                                          edge), 1.3)
        rel = rel - np.where(broken, cfg["crack_depth_mm"] * cmask, 0.0)
    return w, rel
