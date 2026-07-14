"""CLI test renderer: python -m battlefield.cli --seed 42 -o test.png"""

from __future__ import annotations

import argparse
import sys

from .config import load_preset
from .domain import Domain
from .library import Library
from .render import shade, to_png_bytes, heightmap_png_bytes


def main(argv=None):
    p = argparse.ArgumentParser(description="Render a battlefield region to PNG")
    p.add_argument("--preset", help="preset JSON (config + seed)")
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--x", type=float, default=0.0, help="region left (mm)")
    p.add_argument("--y", type=float, default=0.0, help="region top (mm)")
    p.add_argument("--w", type=float, default=256.0, help="width (mm)")
    p.add_argument("--h", type=float, default=256.0, help="height (mm)")
    p.add_argument("--ppm", type=float, default=4.0, help="pixels per mm")
    p.add_argument("--mode", default="hillshade",
                   choices=["hillshade", "grey", "color", "raw16"])
    p.add_argument("--library", default="library")
    p.add_argument("-o", "--out", default="render.png")
    args = p.parse_args(argv)

    config, seed = ({}, 0)
    if args.preset:
        config, seed = load_preset(args.preset)
    if args.seed is not None:
        seed = args.seed

    dom = Domain(config, seed, library=Library(args.library))
    h = dom.render_region(args.x, args.y, args.w, args.h, args.ppm)
    rng = dom.estimated_range()
    if args.mode == "raw16":
        data = heightmap_png_bytes(h)
    else:
        data = to_png_bytes(shade(h, args.ppm, args.mode, height_range=rng))
    with open(args.out, "wb") as f:
        f.write(data)
    print(f"wrote {args.out}: {h.shape[1]}x{h.shape[0]} px, "
          f"height {h.min():.3f}..{h.max():.3f} mm (seed={seed})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
