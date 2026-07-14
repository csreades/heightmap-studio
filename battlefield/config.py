"""Config schema, defaults and (de)serialization.

The config is a plain JSON-serializable dict so viewer slider state can be
saved/loaded as presets verbatim. All spatial parameters are in millimeters;
heights/amplitudes are in mm of physical relief on the printed base.

Defaults are tuned for Legions Imperialis scale: ~25 mm bases, 2 mm tall
infantry, target relief roughly 0.3-0.8 mm.
"""

from __future__ import annotations

import copy
import hashlib
import json

DEFAULT_CONFIG = {
    "px_per_mm": 10.0,          # default crop/stamp resolution
    "master_amplitude": 1.0,    # global multiplier on all relief (mm scale)
    "layers": {
        "ground": {
            "enabled": True,
            "scale_mm": 60.0,       # macro undulation wavelength
            "amplitude_mm": 0.45,
            "octaves": 4,
            "lacunarity": 2.0,
            "gain": 0.5,
            "roughness_amplitude_mm": 0.05,
            "roughness_scale_mm": 1.6,
        },
        "cracks": {
            "enabled": True,
            "blend": "add",         # add | min
            "cell_mm": 7.0,
            "width_mm": 0.55,
            "depth_mm": 0.3,
            "falloff": 1.6,         # edge falloff exponent (higher = sharper)
            "jitter": 1.0,
            "warp_mm": 2.0,         # domain warp to de-straighten cell edges
            "source": None,         # library entry id, or None for procedural
            "source_tile_mm": 45.0, # physical size a sourced map covers
            "source_invert": False,
        },
        "craters": {
            "enabled": True,
            "spacing_mm": 34.0,     # avg spawn-cell size; smaller = denser
            "probability": 0.6,     # chance a spawn cell contains a crater
            "min_radius_mm": 2.0,
            "max_radius_mm": 9.0,
            "depth_per_radius": 0.09,  # bowl depth = radius * this (mm)
            "rim_height_rel": 0.55,    # rim height as fraction of bowl depth
            "rim_width_rel": 0.16,     # rim gaussian width, fraction of radius
            "ejecta_falloff": 0.45,    # ejecta decay length, fraction of radius
            # library id, list of ids (per-crater seeded pick), or None for
            # the analytic profile; missing entries fall back to analytic
            "source": ["nasa_lola_tycho", "nasa_lola_copernicus",
                       "nasa_lola_theophilus", "nasa_lola_king",
                       "nasa_lola_aristarchus", "nasa_lola_burg"],
            "source_mix": 1.0,         # 1 = all sourced stamps, 0 = all analytic
            "crack_clearing": 1.0,    # how much impacts wipe the crack layer
        },
        "plates": {
            "enabled": True,
            "tile_mm": 16.0,          # concrete slab size
            "rotation_deg": 12.0,     # grid rotation vs world axes
            "coverage": 0.5,          # 0 = no paving, 1 = everywhere
            "patch_scale_mm": 130.0,  # size of paved/unpaved patches
            "missing_probability": 0.08,  # tiles gone entirely (earth shows)
            "joint_width_mm": 0.7,    # gap between slabs
            "bevel_mm": 0.4,          # edge softening for printability
            "plate_height_mm": 0.16,  # lift above surrounding ground
            "height_var_mm": 0.05,    # per-tile lift variance
            "tilt_mm": 0.09,          # per-tile tilt (subsided slabs)
            "broken_probability": 0.35,
            "crack_depth_mm": 0.16,   # cracks on broken tiles
            "crack_cell_mm": 5.0,
            "crack_width_mm": 0.45,
        },
        "roads": {
            "enabled": False,
            "spacing_mm": 170.0,    # road-network node grid pitch
            "edge_probability": 0.55,
            "junction_probability": 0.3,
            "width_mm": 9.0,
            "offset_mm": -0.12,     # corridor sink below surrounding terrain
            "shoulder_mm": 2.5,     # falloff distance beyond the corridor
            "wobble": 0.12,         # spline waviness, fraction of segment length
            "berm_height_mm": 0.1,
            "berm_width_mm": 1.4,
            "rut_depth_mm": 0.1,
            "rut_offset_mm": 2.4,   # rut centerline distance from road center
            "rut_width_mm": 0.5,
            "crack_surface": 0.35,  # 0..1: how much crack layer shows on road
        },
        "detail": {
            "enabled": True,
            "scale_mm": 0.9,
            "amplitude_mm": 0.04,
            "octaves": 2,
        },
    },
}


def default_config() -> dict:
    return copy.deepcopy(DEFAULT_CONFIG)


def merge_config(partial: dict | None) -> dict:
    """Deep-merge a partial config over the defaults."""
    def merge(base, over):
        out = copy.deepcopy(base)
        for k, v in (over or {}).items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = merge(out[k], v)
            else:
                out[k] = copy.deepcopy(v)
        return out

    return merge(DEFAULT_CONFIG, partial or {})


def config_hash(config: dict, seed: int) -> str:
    """Stable short hash identifying (config, seed) for caching."""
    payload = json.dumps({"config": config, "seed": seed}, sort_keys=True,
                         separators=(",", ":"))
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def save_preset(path: str, config: dict, seed: int) -> None:
    with open(path, "w") as f:
        json.dump({"seed": seed, "config": config}, f, indent=2, sort_keys=True)


def load_preset(path: str) -> tuple[dict, int]:
    with open(path) as f:
        data = json.load(f)
    return merge_config(data.get("config")), int(data.get("seed", 0))
